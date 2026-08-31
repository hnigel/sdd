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

/** 寫一份假的 codex log。內容原樣寫入 —— 解析只認哨兵區塊，不靠任何位置線索。 */
function log(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `[2026-09-01] OpenAI Codex\n--------\nthinking\nsome noise\ncodex\n${body}\n`);
  return p;
}

const BLOCK = (...lines) => `<<<FINDINGS>>>\n${lines.join('\n')}\n<<<END-FINDINGS>>>`;

const TWO_BLOCKERS = BLOCK(
  'B1 BLOCKER a.mjs:12 基準寫死 HEAD，commit 後抓不到',
  'B2 BLOCKER a.mjs:40 deny 拼錯會靜默失效',
  'P1 POLISH 命名',
);

describe('⭐ 一輪的有效性（只有 RC=0 且拿得到 findings 區塊才算）', () => {
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

  it('log 是空的 → REVIEW_ERROR', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'b.log', ''));
      assert.equal(r.status, 21);
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

describe('⭐⭐⭐ 迴歸：舊版散文解析製造的三種假綠', () => {
  // 這三個 case 對應 2026-09-01 回報的實際 bug。
  // 舊版把「含 BLOCKER 字樣的行」當一條 finding，三種情況都會**偏低**，
  // 而偏低的方向就是假綠：收口那一兩條之後 green_allowed 直接變 true。

  it('⭐ 章節標題 **BLOCKER** + **B1**…**B6** 條目 —— 不得只數到標題', () => {
    const { dir, cleanup } = sandbox();
    try {
      const prose = ['**BLOCKER**', '', '**B1** a:1 x', '**B2** a:2 x', '**B3** a:3 x',
        '**B4** a:4 x', '**B5** a:5 x', '**B6** a:6 x', '', '**POLISH**', '', '- 命名'].join('\n');
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'd.log', prose));
      assert.equal(r.status, 21, `六條 BLOCKER 的散文不得被當成有效一輪：${r.stdout}`);
      assert.equal(JSON.parse(r.stdout).verdict, 'REVIEW_ERROR');
      assert.equal(JSON.parse(run(dir, '--status', 'S3').stdout).rounds_done, 0);
    } finally { cleanup(); }
  });

  it('⭐ final message 在 log 裡出現兩次 —— 不得把同一批算兩次', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const dup = `${TWO_BLOCKERS}\ntokens used: 12000\n${TWO_BLOCKERS}`;
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'e.log', dup));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).blockers, 2, '取最後一個區塊，不是把兩份加起來');
    } finally { cleanup(); }
  });

  it('⭐⭐ 真實 codex 逐字稿（含它把原始碼倒出來）—— 舊版數出 19 條假 finding', () => {
    const { dir, cleanup } = sandbox();
    try {
      const real = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), 'fixtures-codex-transcript.log'), 'utf8');
      // 這份逐字稿裡「BLOCKER」出現 38 次，全部來自 prompt 與被倒出來的原始碼註解，
      // 沒有一條是真的 finding；而且那次 review 根本還沒產出最終回覆。
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'f.log', real));
      assert.equal(r.status, 21, `逐字稿不得被解讀成 findings：${r.stdout}`);
      assert.match(JSON.parse(r.stdout).why, /找不到/);
      assert.equal(JSON.parse(run(dir, '--status', 'S3').stdout).rounds_done, 0);
    } finally { cleanup(); }
  });

  it('⭐ 被倒出來的檔案裡剛好有哨兵格式 —— 取最後一個（真正的回答一定在最後）', () => {
    const { dir, cleanup } = sandbox();
    try {
      const decoy = BLOCK('B1 BLOCKER 這是被倒出來的說明文件裡的範例');
      const body = `一些工具輸出\n${decoy}\n更多輸出\n${TWO_BLOCKERS}`;
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'g.log', body));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).blockers, 2);
    } finally { cleanup(); }
  });
});

describe('⭐⭐ 契約不合就拒絕，絕不寬容', () => {
  it('區塊裡有不合格式的行 → rc=2', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const bad = BLOCK('B1 BLOCKER 好的', '這行沒有編號');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'h.log', bad));
      assert.equal(r.status, 2);
      assert.match(r.stderr, /不合格式的行/);
    } finally { cleanup(); }
  });

  it('⭐ 編號跳號（輸出被截斷的徵兆）→ rc=2，不得只算看得到的那幾條', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const gap = BLOCK('B1 BLOCKER x', 'B2 BLOCKER x', 'B5 BLOCKER x');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'i.log', gap));
      assert.equal(r.status, 2);
      assert.match(r.stderr, /連續/);
    } finally { cleanup(); }
  });

  it('B* 配 POLISH（等級對不上）→ rc=2', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log',
        log(dir, 'j.log', BLOCK('B1 POLISH 這是錯的')));
      assert.equal(r.status, 2);
      assert.match(r.stderr, /對不上/);
    } finally { cleanup(); }
  });

  it('區塊存在但沒有 B 行 → 0 條，這是**明確**的「沒有 BLOCKER」', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log',
        log(dir, 'k.log', BLOCK('P1 POLISH 命名')));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).blockers, 0);
      assert.equal(JSON.parse(r.stdout).verdict, 'CLEAR');
    } finally { cleanup(); }
  });

  it('--blockers 逃生口仍然可用（明確宣告，可稽核）', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log',
        log(dir, 'l.log', '沒有格式的散文'), '--blockers', '3');
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).blockers, 3);
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
      assert.match(block.stdout, /基準寫死 HEAD/, '要附上一輪的 findings 區塊當安全網');
      assert.match(block.stdout, /<<<FINDINGS>>>/, '要把本輪的格式要求帶下去，否則下一輪又拿不到區塊');
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
