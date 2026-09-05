/**
 * state-lock —— 鎖的歸屬
 *
 * 這支存在的理由：`release()` 舊版按**路徑**無條件刪鎖，不看那把鎖還是不是自己的。
 * 於是「操作者人工刪掉疑似殘留的鎖 → 另一個行程取得鎖 → 原持有者結束」
 * 會把**別人的鎖**刪掉，讓第三個行程進來，造成兩個行程同時寫狀態檔 ——
 * 正是這把鎖存在要擋的事。（2026-09-05 異廠商審查 S3 R1 的 B5。）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../scripts/lib/state-lock.mjs';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'lk-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const state = join(dir, '.claude', 'state.json');
  writeFileSync(state, '{}');
  return { dir, state, lock: `${state}.lock`, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('⭐⭐ 鎖只刪自己那一把', () => {
  it('鎖被人工刪除後由別人重建 → 原持有者結束時不得刪掉別人的鎖', () => {
    const { state, lock, cleanup } = sandbox();
    try {
      let otherIno;
      withLock(state, () => {
        // 模擬：操作者看到「疑似殘留」而人工刪掉，接著另一個行程取得鎖
        unlinkSync(lock);
        const fd = openSync(lock, 'wx');
        writeFileSync(fd, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
        closeSync(fd);
        otherIno = statSync(lock).ino;
      }, () => assert.fail('不該進 onBusy'));

      assert.ok(existsSync(lock), '別人的鎖被刪掉了 —— 第三個行程會進來同時寫狀態檔');
      assert.equal(statSync(lock).ino, otherIno, '留在原地的必須還是別人那一把');
    } finally { cleanup(); }
  });

  it('正常情況：自己的鎖要被清掉，否則下一個指令被自己卡住', () => {
    const { state, lock, cleanup } = sandbox();
    try {
      withLock(state, () => assert.ok(existsSync(lock), '持鎖期間鎖要在'), () => assert.fail());
      assert.ok(!existsSync(lock), '正常結束沒清掉鎖 ⇒ 下一個指令被自己卡住');
    } finally { cleanup(); }
  });

  it('鎖在持有期間被刪光且沒人重建 → 不炸，也沒東西要刪', () => {
    const { state, lock, cleanup } = sandbox();
    try {
      withLock(state, () => unlinkSync(lock), () => assert.fail());
      assert.ok(!existsSync(lock));
    } finally { cleanup(); }
  });

  it('已經有鎖 → 走 onBusy，不搶不排隊', () => {
    const { state, lock, cleanup } = sandbox();
    try {
      writeFileSync(lock, '{}');
      let busy = false;
      withLock(state, () => assert.fail('不該拿到鎖'), () => { busy = true; });
      assert.ok(busy, 'fail-closed：拿不到鎖要交給呼叫端處理');
      assert.ok(existsSync(lock), '別人的鎖不得被動到');
    } finally { cleanup(); }
  });
});
