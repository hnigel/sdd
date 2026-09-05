/**
 * 狀態檔的鎖與原子寫入 —— review-state 與 spec-freeze 共用
 *
 * ## 為什麼需要
 * 狀態檔是「每個專案一份、按 stage 分」，而 owner 常在同一個專案裡並行跑多件事。
 * 舊版 `save()` 是裸的 `writeFileSync`：兩個並行的 `--record` 都通過入場守衛、
 * 各自寫一輪，**最後寫入的會覆蓋掉另一邊**，而且是無聲的。
 * 若被覆蓋掉的那一輪帶著 BLOCKER，留下的是清空輪 ⇒ 假綠。
 *
 * ## 兩層防護
 * ① `openSync(lock, 'wx')` 取鎖 —— 拿不到就 **rc=2 fail-closed**，不排隊、不搶。
 * ② tmp + `renameSync` 原子替換 —— 就算行程被砍，也不會留下半份 JSON 讓 `--status` 讀到。
 *
 * ## 為什麼不自動搶殘留鎖
 * 搶錯比停下貴：另一邊可能只是跑得慢（xhigh 的 review 動輒十幾分鐘）。
 * 超過 STALE_MS 只**提示**是殘留、要人工刪，絕不自己刪。
 */
import fs from 'node:fs';
import path from 'node:path';

const STALE_MS = 10 * 60 * 1000;   // 超過這個歲數才提示「疑似殘留」

/** 原子替換：先寫暫存檔，再 rename。同一個檔案系統上 rename 是原子的。 */
export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * 取鎖跑 fn，結束（含丟出例外）一定釋放。
 * 拿不到鎖 ⇒ 呼叫 onBusy(訊息) —— 由呼叫端決定怎麼退出（一律 fail-closed）。
 */
export function withLock(stateFile, fn, onBusy) {
  const lock = `${stateFile}.lock`;
  let fd;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fd = fs.openSync(lock, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let age = '';
    try {
      const ms = Date.now() - fs.statSync(lock).mtimeMs;
      age = ms > STALE_MS
        ? `\n  這個鎖已經 ${Math.round(ms / 60000)} 分鐘沒動 —— 疑似殘留。`
          + `\n  確認沒有別的行程在跑之後，人工刪掉：rm ${lock}`
          + '\n  （腳本不會自己刪：搶錯比停下貴。）'
        : `\n  鎖的歲數 ${Math.round(ms / 1000)} 秒 —— 另一邊多半還在跑，等它結束。`;
    } catch { /* 鎖剛好被釋放，忽略 */ }
    return onBusy(`狀態檔正被另一個行程使用（${lock}）。${age}`);
  }
  // ⚠️ `finally` 擋不住 `process.exit()` —— 而這些腳本到處都用 exit 表達 rc
  // （usage 是 2、STOP_ASK_OWNER 是 20…）。只靠 finally 會把鎖漏在磁碟上，
  // 下一個指令就被自己卡住。所以同時掛 exit handler。
  /**
   * 釋放：**只刪自己那一把**。
   *
   * ⚠️ 舊版是無條件 `unlinkSync(lock)` —— 按**路徑**刪，不看那把鎖還是不是自己的。
   * 實際會出事的路徑（2026-09-05 由異廠商審查指出，S3 R1 的 B5）：
   *   ① A 取得鎖並開始跑（xhigh 的 review 動輒十幾分鐘）
   *   ② 操作者看到「疑似殘留」的提示，人工 `rm` 掉那把鎖 —— 但 A 還在跑
   *   ③ B 取得鎖（路徑空了），寫進自己的 pid
   *   ④ A 結束，`release()` 把 **B 的鎖**刪掉
   *   ⑤ C 於是能在 B 仍持鎖時進來 ⇒ **兩個行程同時寫狀態檔**
   * 那正是這把鎖存在要擋的事，而它自己製造了那個狀態。
   *
   * ⇒ 用 inode 比對：`fstatSync(fd)` 是我們開的那個檔，`statSync(lock)` 是現在
   *   那條路徑上的檔。**不同就代表這條路徑已經換人了，不要碰。**
   *   失敗方向是安全的：比不出來就留著（fail-closed，下一個人被擋下來），
   *   而不是刪掉別人的（fail-open，兩個人同時寫）。
   *
   * ⚠️ 這依賴 inode 有意義（macOS / Linux / WSL 成立）。
   *
   * ⚠️ **殘留競態，沒有關掉，不要以為關掉了**（2026-09-05 S3 R2 的 B5）：
   * `statSync` 與 `unlinkSync` 是兩個 syscall。若人工刪除＋B 重建**剛好落在這兩者之間**，
   * 我們仍會刪掉 B 的鎖。**POSIX 沒有原子的「比對 inode 後刪除」**，
   * 零依賴（不引 flock 綁定）做不到真正關閉。
   *
   * 這個檢查做到的是把窗口從「人工刪除之後的整段時間」縮到「兩個 syscall 之間」，
   * 那是量的改善不是質的改善。
   *
   * ⇒ **根治不在這裡**：真正該做的是讓 `STALE_MS` 大於持鎖者的預期執行時間，
   * 人就不會被提示去刪一把還活著的鎖（見設計文件 §5.2，列為 P1 實作前必須先決定的事）。
   * 現在 `STALE_MS` 是 10 分鐘，而一次 xhigh review 動輒十幾分鐘 —— **那才是成因**。
   */
  const release = () => {
    let mine = false;
    try {
      const a = fs.fstatSync(fd);
      const b = fs.statSync(lock);
      mine = a.ino === b.ino && a.dev === b.dev;
    } catch { /* 鎖已經不在了 —— 沒東西要刪 */ }
    try { fs.closeSync(fd); } catch { /* 已關 */ }
    if (mine) {
      try { fs.unlinkSync(lock); } catch { /* 剛好被刪，忽略 */ }
    } else if (fs.existsSync(lock)) {
      process.emitWarning(
        `state-lock: ${lock} 已經不是這個行程建立的那一把（可能是被人工刪除後重建）——`
        + ' 不刪它。若確認沒有行程在跑，請人工處理。',
      );
    }
  };
  process.on('exit', release);
  try {
    return fn();
  } finally {
    release();
    process.removeListener('exit', release);
  }
}
