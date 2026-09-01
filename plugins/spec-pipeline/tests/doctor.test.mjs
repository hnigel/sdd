/**
 * doctor —— 這台機器現在能不能正確跑完整條流程
 *
 * ⚠️ 這支的價值全在「它驗不到的東西有沒有誠實講出來」。
 * 所以測試除了驗檢查項，也驗 boundaries 欄位存在、以及它**不寫任何檔案**
 * （否則就變成 owner 明確否決的那種 log）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/doctor.mjs');
const NODE = process.execPath;

function sandbox(pipelineJson) {
  const dir = mkdtempSync(join(tmpdir(), 'dr-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (pipelineJson !== undefined) {
    writeFileSync(join(dir, '.claude', 'pipeline.json'),
      typeof pipelineJson === 'string' ? pipelineJson : JSON.stringify(pipelineJson));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 只放 node 的假 PATH —— 用來把 git / codex 從環境裡拿掉。 */
function bareBin() {
  const b = mkdtempSync(join(tmpdir(), 'bin-'));
  symlinkSync(NODE, join(b, 'node'));
  return b;
}

const run = (dir, { env = {}, args = [] } = {}) =>
  spawnSync(NODE, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });

const parse = (r) => JSON.parse(r.stdout);
const pick = (r, name) => parse(r).checks.find((c) => c.name === name);

describe('doctor —— 環境前提', () => {
  it('正常環境 ⇒ rc=0，且輸出是單一 JSON', () => {
    const { dir, cleanup } = sandbox({ verify_cmd: 'npm test' });
    try {
      const r = run(dir);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const d = parse(r);
      assert.equal(d.summary.verdict, 'READY');
      assert.ok(Array.isArray(d.checks) && d.checks.length >= 6);
    } finally { cleanup(); }
  });

  it('PATH 上沒有 git ⇒ FAIL、rc=1（兩支腳本都靠它，缺了會 ENOENT 中斷）', () => {
    const { dir, cleanup } = sandbox({ verify_cmd: 'x' });
    const bin = bareBin();
    try {
      const r = run(dir, { env: { PATH: bin } });
      assert.equal(pick(r, 'git').status, 'FAIL');
      assert.equal(r.status, 1);
    } finally { cleanup(); rmSync(bin, { recursive: true, force: true }); }
  });

  it('PATH 上沒有 codex ⇒ FAIL（S3/S5 兩道閘門會是壞的）', () => {
    const { dir, cleanup } = sandbox({ verify_cmd: 'x' });
    const bin = bareBin();
    try {
      const r = run(dir, { env: { PATH: bin } });
      assert.equal(pick(r, 'codex').status, 'FAIL');
    } finally { cleanup(); rmSync(bin, { recursive: true, force: true }); }
  });

  it('缺 pipeline.json ⇒ INFO 不是 FAIL（fail-closed 是合法狀態）', () => {
    const { dir, cleanup } = sandbox();
    try {
      const r = run(dir);
      assert.equal(pick(r, 'pipeline_json').status, 'INFO');
      assert.match(pick(r, 'pipeline_json').detail, /fail-closed/);
    } finally { cleanup(); }
  });

  it('pipeline.json 過不了 schema ⇒ FAIL、rc=1', () => {
    const { dir, cleanup } = sandbox({ verify_cmd: 'x', fast_path: { allowGlobs: ['a'] } });
    try {
      const r = run(dir);
      assert.equal(pick(r, 'pipeline_json').status, 'FAIL');
      assert.equal(r.status, 1);
    } finally { cleanup(); }
  });

  it('不帶 --probe-codex 就不會真的呼叫（預設不燒 token）', () => {
    const { dir, cleanup } = sandbox({ verify_cmd: 'x' });
    try {
      assert.equal(pick(run(dir), 'codex_probe').status, 'SKIP');
    } finally { cleanup(); }
  });

  // ⚠️ owner 明確否決 log / 遙測 / retro。doctor 是**當下狀態查詢**，
  // 這條測試就是那個承諾的機械形式。
  it('不寫任何檔案 —— 它是查詢，不是 log', () => {
    const { dir, cleanup } = sandbox({ verify_cmd: 'x' });
    try {
      const before = JSON.stringify([readdirSync(dir), readdirSync(join(dir, '.claude'))]);
      run(dir);
      assert.equal(JSON.stringify([readdirSync(dir), readdirSync(join(dir, '.claude'))]), before);
    } finally { cleanup(); }
  });

  it('誠實聲明驗不到的東西（boundaries 不得為空）', () => {
    const { dir, cleanup } = sandbox({ verify_cmd: 'x' });
    try {
      const b = parse(run(dir)).boundaries;
      assert.ok(Array.isArray(b) && b.length >= 3);
      assert.ok(b.some((x) => /harness|Agent|SendMessage/.test(x)), 'harness 能力驗不到這件事要寫出來');
      assert.ok(b.some((x) => /zsh/.test(x)), 'zsh 片段驗不到這件事要寫出來');
    } finally { cleanup(); }
  });
});
