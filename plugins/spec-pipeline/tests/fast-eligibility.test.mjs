/**
 * fast-eligibility —— F0 的機械判定
 *
 * 這支存在的理由：F0 的**全部價值**在於它是 deterministic 的。
 * 一旦某條規則靜默失效（deny 不再優先、缺設定變成放行、檔數上限失守），
 * 危險的改動就會走 fast path 跳過 S0–S3 —— 而且沒有任何訊號。
 *
 * ⚠️ 退出碼語義：0 = FAST、10 = FULL（**不是錯誤**）、2 = 使用方式/設定錯誤。
 *
 * 跑法（不需要任何依賴）：
 *   node --test plugins/spec-pipeline/tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/fast-eligibility.mjs');

/** 開一個獨立 git repo 當沙盒 —— 不要在真 repo 上測，會被工作樹狀態污染。 */
function sandbox(cfg, files) {
  const dir = mkdtempSync(join(tmpdir(), 'f0-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 't');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (cfg !== null) writeFileSync(join(dir, '.claude/pipeline.json'), JSON.stringify(cfg));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const run = (dir, ...args) => spawnSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
const baselineOf = (dir) => join(dir, '.claude/fast-baseline.json');

const CFG = {
  verify_cmd: 'echo ok',
  fast_path: { allow_globs: ['docs/**', '*.md'], deny_globs: ['docs/secret/**'] },
};

describe('⭐ fail-closed：任何未知一律 FULL', () => {
  it('缺 pipeline.json → FULL（不是放行、也不是爆炸）', () => {
    const { dir, cleanup } = sandbox(null, { 'docs/a.md': 'x' });
    try {
      const r = run(dir, '--check', 'docs/a.md');
      assert.equal(r.status, 10, '缺設定卻放行 ⇒ 沒設定的專案全部裸奔');
      assert.match(JSON.parse(r.stdout).reasons[0], /pipeline\.json/);
    } finally { cleanup(); }
  });

  it('缺 verify_cmd → FULL（不能驗證就不可能宣告 GREEN）', () => {
    const { dir, cleanup } = sandbox({ fast_path: CFG.fast_path }, { 'docs/a.md': 'x' });
    try {
      assert.equal(run(dir, '--check', 'docs/a.md').status, 10);
    } finally { cleanup(); }
  });

  it('缺 fast_path.allow_globs → FULL', () => {
    const { dir, cleanup } = sandbox({ verify_cmd: 'x' }, { 'docs/a.md': 'x' });
    try {
      assert.equal(run(dir, '--check', 'docs/a.md').status, 10);
    } finally { cleanup(); }
  });

  it('不給候選路徑 → 使用方式錯誤（2），不得自己去猜要改哪些檔', () => {
    const { dir, cleanup } = sandbox(CFG, { 'docs/a.md': 'x' });
    try {
      assert.equal(run(dir, '--check').status, 2);
    } finally { cleanup(); }
  });
});

describe('⭐⭐ deny 優先於 allow（順序反了，危險路徑會因為符合 allow 而過關）', () => {
  it('同時命中 allow 與 deny → FULL', () => {
    const { dir, cleanup } = sandbox(CFG, { 'docs/secret/keys.md': 'x' });
    try {
      const r = run(dir, '--check', 'docs/secret/keys.md');
      assert.equal(r.status, 10);
      assert.match(JSON.parse(r.stdout).reasons[0], /deny_globs/);
    } finally { cleanup(); }
  });

  it('只命中 allow → FAST', () => {
    const { dir, cleanup } = sandbox(CFG, { 'docs/a.md': 'x' });
    try {
      const r = run(dir, '--check', 'docs/a.md');
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).verdict, 'fast');
    } finally { cleanup(); }
  });

  it('兩邊都不中 → FULL', () => {
    const { dir, cleanup } = sandbox(CFG, { 'src/x.ts': 'x' });
    try {
      assert.equal(run(dir, '--check', 'src/x.ts').status, 10);
    } finally { cleanup(); }
  });

  it('⭐⭐ deny_globs 拼錯 → 設定錯誤（2），不得因為 deny 消失而放行', () => {
    // 這是唯一一個 fail-OPEN 的洞：allow 拼錯會 FULL（安全），
    // deny 拼錯卻讓整條 deny 靜默失效 ⇒ 敏感檔拿到 FAST 且沒有訊號。
    const bad = { verify_cmd: 'x', fast_path: { allow_globs: ['**/*.md'], denyGlobs: ['**/*secret*'] } };
    const { dir, cleanup } = sandbox(bad, { 'config/secrets.md': 'KEY=abc' });
    try {
      const r = run(dir, '--check', 'config/secrets.md');
      assert.equal(r.status, 2, `拼錯 deny_globs 卻放行了：${r.stdout}`);
      assert.match(r.stderr, /未知鍵/);
    } finally { cleanup(); }
  });

  it('`_` 開頭的註解鍵不算未知鍵（既有設定用 _comment 寫理由）', () => {
    const withComments = {
      verify_cmd: 'x',
      fast_path: { _comment: '理由', _excluded_on_purpose: {}, allow_globs: ['docs/**'] },
    };
    const { dir, cleanup } = sandbox(withComments, { 'docs/a.md': 'x' });
    try {
      assert.equal(run(dir, '--check', 'docs/a.md').status, 0);
    } finally { cleanup(); }
  });
});

describe('進場條件', () => {
  it('超過 2 檔 → FULL', () => {
    const { dir, cleanup } = sandbox(CFG, { 'docs/a.md': 'x', 'docs/b.md': 'x', 'docs/c.md': 'x' });
    try {
      const r = run(dir, '--check', 'docs/a.md', 'docs/b.md', 'docs/c.md');
      assert.equal(r.status, 10);
      assert.match(JSON.parse(r.stdout).reasons.join(), /候選檔數/);
    } finally { cleanup(); }
  });

  it('⭐ 候選路徑入場不乾淨 → FULL（dirty tree 下分不出哪些 diff 屬於本次）', () => {
    const { dir, cleanup } = sandbox(CFG, { 'docs/a.md': 'x' });
    try {
      writeFileSync(join(dir, 'docs/a.md'), 'dirty');
      const r = run(dir, '--check', 'docs/a.md');
      assert.equal(r.status, 10);
      assert.match(JSON.parse(r.stdout).reasons.join(), /入場不乾淨/);
    } finally { cleanup(); }
  });

  it('新增檔案（不存在）→ FULL', () => {
    const { dir, cleanup } = sandbox(CFG, { 'docs/a.md': 'x' });
    try {
      assert.equal(run(dir, '--check', 'docs/new.md').status, 10);
    } finally { cleanup(); }
  });
});

describe('⭐⭐ S4 之後的 scope 重驗', () => {
  it('界內改動 → FAST', () => {
    const { dir, cleanup } = sandbox(CFG, { 'docs/a.md': 'x\n' });
    try {
      assert.equal(run(dir, '--check', 'docs/a.md').status, 0);
      writeFileSync(join(dir, 'docs/a.md'), 'x\ny\n');
      const r = run(dir, '--verify-scope', baselineOf(dir));
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally { cleanup(); }
  });

  it('⭐ 動到 scope 外 → FULL，且**不自動回滾**（保留 diff 給人看）', () => {
    const { dir, cleanup } = sandbox(CFG, { 'docs/a.md': 'x\n', 'docs/b.md': 'y\n' });
    try {
      run(dir, '--check', 'docs/a.md');
      writeFileSync(join(dir, 'docs/b.md'), 'changed\n');
      const r = run(dir, '--verify-scope', baselineOf(dir));
      assert.equal(r.status, 10);
      const out = JSON.parse(r.stdout);
      assert.equal(out.action, 'stop-implementer; keep-diff; retriage', 'diff 是實作成果，超界時保留不回滾');
      assert.match(out.reasons.join(), /docs\/b\.md/);
    } finally { cleanup(); }
  });

  it('⭐⭐ implementer commit 之後，scope 外的改動照樣要被抓到', () => {
    // 舊版基準寫死 `HEAD` ⇒ 一 commit 就 diff 不出東西，回報 0 檔 0 行的假綠。
    // 基準必須是**入場時記下的 commit**。
    const { dir, git, cleanup } = sandbox(CFG, { 'docs/a.md': 'x\n', 'src/app.js': 'x=1\n' });
    try {
      assert.equal(run(dir, '--check', 'docs/a.md').status, 0);
      writeFileSync(join(dir, 'docs/a.md'), 'x\ny\n');
      writeFileSync(join(dir, 'src/app.js'), 'x=1\nSNEAKY\n');
      git('add', '-A');
      git('commit', '-qm', 'work');
      const r = run(dir, '--verify-scope', baselineOf(dir));
      assert.equal(r.status, 10, `commit 之後就抓不到 scope 外改動了：${r.stdout}`);
      assert.match(JSON.parse(r.stdout).reasons.join(), /src\/app\.js/);
    } finally { cleanup(); }
  });

  it('超過 80 行 → FULL', () => {
    const { dir, cleanup } = sandbox(CFG, { 'docs/a.md': 'x\n' });
    try {
      run(dir, '--check', 'docs/a.md');
      writeFileSync(join(dir, 'docs/a.md'), Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'));
      const r = run(dir, '--verify-scope', baselineOf(dir));
      assert.equal(r.status, 10);
      assert.match(JSON.parse(r.stdout).reasons.join(), /行數/);
    } finally { cleanup(); }
  });

  it('⭐ 進場時就存在的 untracked 檔不得被誤判成 scope 外（實測時踩過）', () => {
    const { dir, cleanup } = sandbox(CFG, { 'docs/a.md': 'x\n' });
    try {
      writeFileSync(join(dir, 'stray.txt'), 'pre-existing untracked');
      assert.equal(run(dir, '--check', 'docs/a.md').status, 0);
      writeFileSync(join(dir, 'docs/a.md'), 'x\ny\n');
      const r = run(dir, '--verify-scope', baselineOf(dir));
      assert.equal(r.status, 0, '把進場前就有的 untracked 算成本次變更 ⇒ 永遠紅，F0 等於不能用');
    } finally { cleanup(); }
  });

  it('⭐ 進場時就已經改過的 tracked 檔同理，不得讓守規矩的實作事後被踢回 full', () => {
    // check 只掃候選路徑、verify-scope 掃全樹 ⇒ 不記 dirty_at_entry 的話兩邊不對稱。
    const { dir, cleanup } = sandbox(CFG, { 'docs/a.md': 'x\n', 'src/app.js': 'x=1\n' });
    try {
      writeFileSync(join(dir, 'src/app.js'), 'x=1\nunrelated pre-existing edit\n');
      assert.equal(run(dir, '--check', 'docs/a.md').status, 0);
      writeFileSync(join(dir, 'docs/a.md'), 'x\ny\n');
      const r = run(dir, '--verify-scope', baselineOf(dir));
      assert.equal(r.status, 0, `與本次無關的髒檔害守規矩的實作被踢回 full：${r.stdout}`);
    } finally { cleanup(); }
  });
});
