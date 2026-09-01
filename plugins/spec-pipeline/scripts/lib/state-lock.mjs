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
  const release = () => {
    try { fs.closeSync(fd); } catch { /* 已關 */ }
    try { fs.unlinkSync(lock); } catch { /* 已刪 */ }
  };
  process.on('exit', release);
  try {
    return fn();
  } finally {
    release();
    process.removeListener('exit', release);
  }
}
