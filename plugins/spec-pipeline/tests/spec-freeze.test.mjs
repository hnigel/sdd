/**
 * spec-freeze —— 凍結的規格是唯一驗收依據，而「回去改規格」要便宜
 *
 * ⚠️ 退出碼：0 = OK、10 = 還沒凍結（**不是錯誤**）、20 = SPEC_DRIFT、2 = 使用方式錯誤。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/spec-freeze.mjs');
const SPEC = 'design-2026-08-31.md';
const BODY = '# 設計\n\n## 1. 目標\n把 F0 改成腳本。\n\n## 2. 驗收\nrc=0 才算 FAST。\n';

function sandbox(reviewState) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, SPEC), BODY);
  if (reviewState) writeFileSync(join(dir, '.claude/review-state.json'), JSON.stringify(reviewState));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const run = (dir, ...a) => spawnSync('node', [SCRIPT, ...a], { cwd: dir, encoding: 'utf8' });

const clearS3 = { version: 1, stages: { S3: { task: 't', rounds: [{ n: 1, blockers: [] }], invocation_failures: [] } } };
const openS3 = {
  version: 1,
  stages: { S3: { task: 't', rounds: [{ n: 1, blockers: [{ id: 'B1', text: 'x', resolved: null }] }], invocation_failures: [] } },
};

describe('⭐ 凍結的前提：S3 要先收口', () => {
  it('S3 還有未收口的 BLOCKER → 拒絕凍結(20)', () => {
    const { dir, cleanup } = sandbox(openS3);
    try {
      const r = run(dir, '--freeze', SPEC);
      assert.equal(r.status, 20);
      assert.match(r.stderr, /不得凍結/);
    } finally { cleanup(); }
  });

  it('S3 收口了 → 可以凍結', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      assert.equal(run(dir, '--freeze', SPEC).status, 0);
      assert.equal(JSON.parse(run(dir, '--check').stdout).verdict, 'OK');
    } finally { cleanup(); }
  });

  // ⚠️ 舊版這兩條路徑都是「印一行警告然後照常凍結」——
  // 於是完全沒過 S3 的規格可以被凍結成「唯一驗收依據」。
  // 「沒有通過的證據」不是可以放行的例外。
  it('沒有 review-state → rc=20，不得凍結', () => {
    const { dir, cleanup } = sandbox(null);
    try {
      const r = run(dir, '--freeze', SPEC);
      assert.equal(r.status, 20, `拿到 rc=${r.status}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /不得凍結/);
    } finally { cleanup(); }
  });

  // ⚠️ 重新 freeze 曾經是 SPEC_DRIFT 的免費出口：改完規格不走 --revise，
  // 直接再 --freeze 一次，就用「改動之前」那一輪清空輪祝福新內容、把 revisions 清空，
  // --check 從此回 OK —— 那一輪根本沒看過新內容。
  it('已凍結且內容改變 → --freeze rc=20，且 SPEC_DRIFT 沒有被洗白', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      assert.equal(run(dir, '--freeze', SPEC).status, 0);
      writeFileSync(join(dir, SPEC), '偷偷改過的內容');
      assert.equal(JSON.parse(run(dir, '--check').stdout).verdict, 'SPEC_DRIFT');

      const r = run(dir, '--freeze', SPEC);
      assert.equal(r.status, 20, r.stdout + r.stderr);
      assert.match(r.stderr, /--revise/);
      // 關鍵：擋下來之後，drift 判定不能被洗掉
      assert.equal(JSON.parse(run(dir, '--check').stdout).verdict, 'SPEC_DRIFT');
    } finally { cleanup(); }
  });

  it('內容沒變時重新 --freeze 仍可用（不是無差別禁止）', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      assert.equal(run(dir, '--freeze', SPEC).status, 0);
      assert.equal(run(dir, '--freeze', SPEC).status, 0);
    } finally { cleanup(); }
  });

  it('--force 沒帶 --why ⇒ rc=2；帶了才放行並留下 discarded_freeze', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      run(dir, '--freeze', SPEC);
      writeFileSync(join(dir, SPEC), '換一份全新的規格');
      assert.equal(run(dir, '--freeze', SPEC, '--force').status, 2);
      const r = run(dir, '--freeze', SPEC, '--force', '--why', '換主題');
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const st = JSON.parse(readFileSync(join(dir, '.claude', 'spec-freeze.json'), 'utf8'));
      assert.equal(st.discarded_freeze.why, '換主題');
    } finally { cleanup(); }
  });

  it('S3 沒有任何一輪 → rc=20，不得凍結', () => {
    const { dir, cleanup } = sandbox({ version: 1, stages: { S3: { task: 't', rounds: [], invocation_failures: [] } } });
    try {
      const r = run(dir, '--freeze', SPEC);
      assert.equal(r.status, 20, `拿到 rc=${r.status}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /不得凍結/);
    } finally { cleanup(); }
  });
});

describe('⭐⭐ 偵測「把規格偷偷改成符合實作」', () => {
  it('規格被改但沒走 --revise → SPEC_DRIFT(20)', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      run(dir, '--freeze', SPEC);
      writeFileSync(join(dir, SPEC), BODY.replace('rc=0 才算 FAST。', 'rc 隨便啦。'));
      const r = run(dir, '--check');
      assert.equal(r.status, 20);
      const o = JSON.parse(r.stdout);
      assert.equal(o.verdict, 'SPEC_DRIFT');
      assert.match(o.note, /追認/);
    } finally { cleanup(); }
  });

  it('規格檔被刪掉也算 drift', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      run(dir, '--freeze', SPEC);
      rmSync(join(dir, SPEC));
      assert.equal(run(dir, '--check').status, 20);
    } finally { cleanup(); }
  });

  it('還沒凍結 → rc=10，不是錯誤也不是假裝 OK', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      assert.equal(run(dir, '--check').status, 10);
    } finally { cleanup(); }
  });
});

describe('⭐⭐ --revise 讓誠實的路變便宜', () => {
  it('revise 之後 check 回到 OK，且 delta 只含改動那一段', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      run(dir, '--freeze', SPEC);
      writeFileSync(join(dir, SPEC), BODY.replace('rc=0 才算 FAST。', 'rc=0 且 scope 重驗過才算 FAST。'));
      const rv = run(dir, '--revise', SPEC, '--why', '原本漏了 S4 之後的 scope 重驗');
      assert.equal(rv.status, 0, rv.stderr);
      assert.equal(JSON.parse(rv.stdout).revision, '第 1 次');
      assert.equal(run(dir, '--check').status, 0, 'revise 之後就不該再算 drift');

      const d = run(dir, '--delta');
      assert.equal(d.status, 0);
      assert.match(d.stdout, /只審這段 delta/);
      assert.match(d.stdout, /原本漏了 S4 之後的 scope 重驗/);
      assert.match(d.stdout, /\+.*scope 重驗過才算 FAST/, 'delta 要含新內容');
      assert.match(d.stdout, /-.*rc=0 才算 FAST/, 'delta 要含被換掉的舊內容');
      assert.match(d.stdout, /--- a\/design-2026-08-31\.md/, 'diff 標頭要是乾淨的檔名，不是暫存路徑或 aa/');
      assert.doesNotMatch(d.stdout, /aa\/|\/tmp\/|\/var\/folders/, '不該漏出暫存路徑或重複前綴');
      assert.doesNotMatch(d.stdout, /## 1\. 目標/, '沒動到的段落不該出現在 delta —— 不然就是整份重審');
    } finally { cleanup(); }
  });

  it('--revise 沒給 --why → 使用方式錯誤', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      run(dir, '--freeze', SPEC);
      writeFileSync(join(dir, SPEC), `${BODY}改了\n`);
      assert.equal(run(dir, '--revise', SPEC).status, 2);
    } finally { cleanup(); }
  });

  it('規格根本沒變就 revise → 擋掉，不留空修訂', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      run(dir, '--freeze', SPEC);
      assert.equal(run(dir, '--revise', SPEC, '--why', 'x').status, 2);
    } finally { cleanup(); }
  });

  // ⚠️ 這一題原本斷言「--delta 給最近一次」——**那是把 D4 的形狀寫死成期望值**。
  // 連續 revise 兩次未複審時，第一次的修改會從素材裡消失並隨這輪 CLEAR 被帶過。
  // 現在改成全送；原本要守的性質（第二筆不該把第一筆再算成新增）保留，但限縮到第二筆那一段。
  it('多次修訂全部進 --delta —— 少送會讓未審的修改溜過去（D4 的形狀）', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      run(dir, '--freeze', SPEC);
      writeFileSync(join(dir, SPEC), `${BODY}## 3. 第一次補充\n`);
      run(dir, '--revise', SPEC, '--why', '第一個理由');
      writeFileSync(join(dir, SPEC), `${BODY}## 3. 第一次補充\n## 4. 第二次補充\n`);
      const rv = run(dir, '--revise', SPEC, '--why', '第二個理由');
      assert.equal(JSON.parse(rv.stdout).revision, '第 2 次');

      const d = run(dir, '--delta').stdout;
      // ① 兩筆都要在 —— 這是 B1 的修正
      assert.match(d, /第一個理由/, '第一筆未複審，不得從素材裡消失');
      assert.match(d, /第一次補充/);
      assert.match(d, /第二個理由/);
      assert.match(d, /第二次補充/);
      assert.match(d, /全部都要審/, '多筆時要明講不只看最後一筆');

      // ② 原本的性質：第二筆的 diff 不該把第一筆的內容再算成新增
      const sections = d.split(/^### 修訂 #/m);
      const rev2 = sections.find((x) => x.startsWith('2'));
      assert.ok(rev2, '要能切出第二筆那一段');
      assert.doesNotMatch(rev2, /^\+.*第一次補充/m,
        '第一次的改動已經凍進第二筆的基準，不該在第二筆裡再被算成新增');
    } finally { cleanup(); }
  });

  it('只有一筆修訂時，標題仍是單筆的講法（不要無謂嚇人）', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      run(dir, '--freeze', SPEC);
      writeFileSync(join(dir, SPEC), `${BODY}## 3. 只改一次\n`);
      run(dir, '--revise', SPEC, '--why', '唯一的理由');
      const d = run(dir, '--delta').stdout;
      assert.match(d, /規格修訂 #1/);
      assert.doesNotMatch(d, /全部都要審/);
    } finally { cleanup(); }
  });

  it('凍結之後沒改過 → --delta 回 10（沒有 delta，不是錯誤）', () => {
    const { dir, cleanup } = sandbox(clearS3);
    try {
      run(dir, '--freeze', SPEC);
      assert.equal(run(dir, '--delta').status, 10);
    } finally { cleanup(); }
  });
});
