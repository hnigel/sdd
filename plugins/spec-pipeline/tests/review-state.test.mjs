/**
 * review-state —— Codex review 的跨 session 操作狀態
 *
 * 這支存在的理由跟 fast-eligibility 一樣：輪數與停止條件如果是散文，
 * 實際數數的還是模型，而「這算第幾輪」「這條算不算收口」都可以自我說服。
 *
 * ⚠️ 退出碼：0 = OK、10 = 沒有前輪狀態（**不是錯誤**）、
 *            20 = STOP_ASK_OWNER、21 = REVIEW_ERROR、2 = 使用方式錯誤。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/review-state.mjs');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'rs-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const run = (dir, ...args) => spawnSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });

/** 假的 codex log：final response 在最後一個單獨的 `codex` 行之後 */
function log(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `[2026-08-31] OpenAI Codex\n--------\nthinking\nsome noise\ncodex\n${body}\n`);
  return p;
}

const TWO_BLOCKERS = `BLOCKER 1: verify-scope 的基準是 HEAD，implementer 一 commit 就抓不到
  這會回報 0 檔 0 行的假綠。

BLOCKER 2: deny_globs 拼錯會靜默失效

POLISH: 變數命名`;

describe('⭐ 一輪的有效性（只有 RC=0 且回覆非空才算）', () => {
  it('RC≠0 → REVIEW_ERROR(21)，而且**輪數不增加**', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '1', '--log', log(dir, 'a.log', 'x'));
      assert.equal(r.status, 21);
      assert.match(JSON.parse(r.stdout).note, /輪數沒有增加/);
      assert.equal(JSON.parse(run(dir, '--status', 'S3').stdout).rounds_done, 0);
    } finally { cleanup(); }
  });

  it('RC=0 但 final response 是空的 → 一樣 REVIEW_ERROR', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'b.log', ''));
      assert.equal(r.status, 21);
      assert.match(JSON.parse(r.stdout).why, /空/);
    } finally { cleanup(); }
  });

  it('⭐ invocation-retry 用完（>2）→ STOP_ASK_OWNER(20)', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const l = log(dir, 'c.log', 'x');
      assert.equal(run(dir, '--record', 'S3', '--rc', '1', '--log', l).status, 21);
      assert.equal(run(dir, '--record', 'S3', '--rc', '1', '--log', l).status, 21);
      assert.equal(run(dir, '--record', 'S3', '--rc', '1', '--log', l).status, 20);
    } finally { cleanup(); }
  });
});

describe('⭐⭐ 抓不到格式標記時不得當作零', () => {
  it('回覆沒有 BLOCKER/POLISH → 使用方式錯誤(2)，逼呼叫端明講', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'd.log', '看起來都還不錯，沒什麼大問題'));
      assert.equal(r.status, 2, '抓不到就當零 ⇒ 一份沒格式的回覆會直接變成 CLEAR');
      assert.match(r.stderr, /不會.*因為抓不到就當作零/);
    } finally { cleanup(); }
  });

  it('明講 --blockers 就放行', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'e.log', '隨便寫'), '--blockers', '2');
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).blockers, 2);
    } finally { cleanup(); }
  });

  it('「沒有 BLOCKER」這種宣告不算一條 finding', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'f.log', '沒有 BLOCKER。\n\nPOLISH: 命名'));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const o = JSON.parse(r.stdout);
      assert.equal(o.blockers, 0);
      assert.equal(o.verdict, 'CLEAR');
    } finally { cleanup(); }
  });
});

describe('⭐⭐ 停止條件是機械的', () => {
  it('R3 仍有 BLOCKER → STOP_ASK_OWNER(20)，不得再開下一輪', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const l = log(dir, 'g.log', TWO_BLOCKERS);
      assert.equal(run(dir, '--record', 'S3', '--rc', '0', '--log', l).status, 0);
      assert.equal(run(dir, '--record', 'S3', '--rc', '0', '--log', l).status, 0);
      const r3 = run(dir, '--record', 'S3', '--rc', '0', '--log', l);
      assert.equal(r3.status, 20);
      assert.match(JSON.parse(r3.stdout).note, /停下來問 owner/);
    } finally { cleanup(); }
  });

  it('沒有有效的一輪 → green_allowed = false', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      assert.equal(JSON.parse(run(dir, '--status', 'S3').stdout).green_allowed, false);
    } finally { cleanup(); }
  });

  it('還有未收口的 BLOCKER → green_allowed = false', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'h.log', TWO_BLOCKERS));
      const s = JSON.parse(run(dir, '--status', 'S3').stdout);
      assert.equal(s.green_allowed, false);
      assert.deepEqual(s.open_blockers, ['B1', 'B2']);
    } finally { cleanup(); }
  });

  it('S3 與 S5 各自獨立計數', () => {
    const { dir, cleanup } = sandbox();
    try {
      const l = log(dir, 'i.log', TWO_BLOCKERS);
      run(dir, '--start', 'S3', '--task', 't');
      run(dir, '--start', 'S5', '--task', 't');
      run(dir, '--record', 'S3', '--rc', '0', '--log', l);
      run(dir, '--record', 'S3', '--rc', '0', '--log', l);
      assert.equal(JSON.parse(run(dir, '--status', 'S3').stdout).rounds_done, 2);
      assert.equal(JSON.parse(run(dir, '--status', 'S5').stdout).rounds_done, 0);
    } finally { cleanup(); }
  });
});

describe('⭐⭐ 跨 session resume —— 這支存在的全部理由', () => {
  it('新的 process（= 新 session）讀得到前輪 findings 與我的處理', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', '把 F0 改成腳本');
      run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'j.log', TWO_BLOCKERS));
      run(dir, '--resolve', 'S3', '--item', 'B1', '--how', '改成 diff 入場 commit，補測試');

      // 到這裡為止的狀態全部只存在檔案裡；下面每一次 run 都是全新 process
      const block = run(dir, '--prompt-block', 'S3');
      assert.equal(block.status, 0, block.stderr);
      assert.match(block.stdout, /逐項/);
      assert.match(block.stdout, /B1/);
      assert.match(block.stdout, /改成 diff 入場 commit，補測試/);
      assert.match(block.stdout, /B2[\s\S]*尚未處理/, '沒處理的要標成尚未處理，不能混進去');
      assert.match(block.stdout, /verify-scope 的基準是 HEAD/, '要附上一輪逐字回覆當安全網');
    } finally { cleanup(); }
  });

  it('沒有任何狀態 → rc=10「當成新 run 從初審開始」，不是錯誤也不是假裝有', () => {
    const { dir, cleanup } = sandbox();
    try {
      const r = run(dir, '--prompt-block', 'S3');
      assert.equal(r.status, 10);
      assert.match(r.stderr, /從初審開始/);
    } finally { cleanup(); }
  });

  it('--resolve 之後 status 反映出來', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'k.log', TWO_BLOCKERS));
      run(dir, '--resolve', 'S3', '--item', 'B1', '--how', 'x');
      run(dir, '--resolve', 'S3', '--item', 'B2', '--how', 'y');
      const s = JSON.parse(run(dir, '--status', 'S3').stdout);
      assert.deepEqual(s.open_blockers, []);
      assert.equal(s.green_allowed, true);
    } finally { cleanup(); }
  });

  it('--resolve 不存在的 id → 使用方式錯誤，不得默默成功', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'l.log', TWO_BLOCKERS));
      assert.equal(run(dir, '--resolve', 'S3', '--item', 'B9', '--how', 'x').status, 2);
    } finally { cleanup(); }
  });

  it('--start 覆蓋未結束的 run 時要出聲（不得靜默清掉沒收口的項目）', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', '第一件事');
      run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'm.log', TWO_BLOCKERS));
      const r = run(dir, '--start', 'S3', '--task', '第二件事');
      assert.match(r.stderr, /未結束的 run/);
      assert.match(r.stderr, /2 條未收口/);
    } finally { cleanup(); }
  });
});
