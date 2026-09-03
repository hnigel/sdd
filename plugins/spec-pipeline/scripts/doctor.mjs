#!/usr/bin/env node
/**
 * doctor.mjs — 這台機器現在能不能正確跑完整條流程？
 *
 * ## 為什麼需要它
 * owner 有兩台機器（macOS 與 WSL）。plugin cache 版本、codex 登入狀態、
 * config 內容、Node 版本都是 per-machine，而且**漂移沒有訊號** ——
 * 這個 repo 被「兩份東西漂移而且沒有訊號」咬過很多次。
 *
 * ## 它不是 log，也不是遙測
 * **當下狀態查詢**：不寫任何檔案、不累積任何歷史、不算趨勢。
 * owner 否決的是遙測與統計彙總（README「刻意不做」），不是操作狀態查詢
 * —— `review-state.mjs` 已立此區分先例。
 *
 * ## 它能驗什麼、不能驗什麼
 * 見輸出的 `boundaries` 欄位。**那一欄不是免責聲明，是能力邊界表** ——
 * 「doctor 綠 ⇒ 一切正常」是錯的，而把哪些事驗不到寫清楚，比含糊帶過有用。
 *
 * 退出碼：0 = 沒有 FAIL、1 = 有 FAIL。WARN 不影響退出碼。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from './lib/validate-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// probe 用的固定值，**不是契約釘值**。
// ⚠️ 契約只釘 model；effort 依 target 行數決定（codex-review skill 的 effort 表），
//    所以這裡的 xhigh 只是「拿某個值去打一次看環境活不活」，不代表流程該用它。
//    config 漂移的比對也只對 model 有意義。
const PINNED_MODEL = 'gpt-5.6-sol';
const PINNED_EFFORT = 'xhigh';

const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });

/** 在 PATH 上找得到並跑得起來嗎。回傳版本字串或 null。 */
function probeBin(bin, args = ['--version']) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout}${r.stderr}`.trim().split('\n')[0];
}

// ── 1. 平台與 Node ──────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split('.')[0]);
add('platform', 'INFO', `${process.platform} ${os.release()} (${process.arch})`);
add('node', nodeMajor >= 18 ? 'OK' : 'FAIL',
  `${process.version}${nodeMajor >= 18 ? '' : ' —— 四支判定腳本需要 18+'}`);

// ── 2. git ──────────────────────────────────────────────────────────────
// fast-eligibility.mjs 與 spec-freeze.mjs 都用 execFileSync 呼叫 git。
// PATH 上沒有它的話，這兩支會在跑到一半 ENOENT 中斷，而不是給出判定。
const gitV = probeBin('git');
add('git', gitV ? 'OK' : 'FAIL',
  gitV ?? '找不到 git —— fast-eligibility 與 spec-freeze 會 ENOENT 中斷');

// ── 3. codex CLI ────────────────────────────────────────────────────────
// S3/S5 兩道閘門全靠它。沒裝的症狀是 RC=1 → REVIEW_ERROR，
// 看起來像 prompt 寫壞，其實是根本沒裝。
const codexV = probeBin('codex');
add('codex', codexV ? 'OK' : 'FAIL',
  codexV ?? '找不到 codex —— S3/S5 兩道閘門現在是壞的');

// ── 4. codex config 漂移 ────────────────────────────────────────────────
// WARN 不是 FAIL：契約本來就在呼叫點明寫 -m / -c，不繼承環境。
// 這一條的價值是讓你看見漂移確實會發生（2026-09-01 實測：同一台從 xhigh 漂到 medium）。
const cfgPath = path.join(os.homedir(), '.codex', 'config.toml');
if (fs.existsSync(cfgPath)) {
  const raw = fs.readFileSync(cfgPath, 'utf8');
  const pick = (k) => (new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm').exec(raw) ?? [])[1] ?? '(未設)';
  const model = pick('model');
  const effort = pick('model_reasoning_effort');
  const drift = model !== PINNED_MODEL || effort !== PINNED_EFFORT;
  add('codex_config_drift', drift ? 'WARN' : 'OK',
    `config.toml: model=${model} effort=${effort}`
    + (drift ? ` —— 與契約釘死值（${PINNED_MODEL}/${PINNED_EFFORT}）不同。不是錯誤：`
      + '契約在呼叫點明寫 -m/-c，本來就覆蓋 config。這條只是讓你看見漂移真的會發生。' : ''));
} else {
  add('codex_config_drift', 'INFO', '沒有 ~/.codex/config.toml（呼叫點明寫，不受影響）');
}

// ── 5. 當前專案的 pipeline.json ─────────────────────────────────────────
// 缺檔不是 FAIL —— 那是合法的 fail-closed 狀態（只能規劃，不得實作）。
const pj = path.join(process.cwd(), '.claude', 'pipeline.json');
if (!fs.existsSync(pj)) {
  add('pipeline_json', 'INFO', `${pj} 不存在 ⇒ fail-closed：只允許規劃與唯讀檢查`);
} else {
  try {
    const schema = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'schemas', 'pipeline.schema.json'), 'utf8'));
    const errs = validate(JSON.parse(fs.readFileSync(pj, 'utf8')), schema);
    add('pipeline_json', errs.length ? 'FAIL' : 'OK', errs.length ? errs.join('；') : pj);
  } catch (e) {
    add('pipeline_json', 'FAIL', `${pj} 讀不了或不是合法 JSON：${e.message}`);
  }
}

// ── 6. plugin 釘在哪個 commit ───────────────────────────────────────────
// 兩台機器可以停在不同 commit 而完全沒有訊號。這一欄印出所有 entry
// （user scope 與各 project scope 都要），兩台各跑一次即可肉眼比對。
const ip = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
if (fs.existsSync(ip)) {
  try {
    const raw = JSON.parse(fs.readFileSync(ip, 'utf8'));
    // 實際形狀是 { version, plugins: { "spec-pipeline@sdd": [...] } }。
    // 兩種都容忍：格式若再變，寧可 WARN 也不要靜默回報「沒有」。
    const all = raw.plugins ?? raw;
    const entries = Object.entries(all)
      .filter(([k]) => k.startsWith('spec-pipeline@'))
      .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((e) => ({
        key: k, scope: e.scope, project: e.projectPath, sha: e.gitCommitSha, path: e.installPath,
      })));
    add('plugin_pin', entries.length ? 'OK' : 'WARN',
      entries.length
        ? entries.map((e) => `${e.scope}${e.project ? `(${e.project})` : ''} sha=${String(e.sha).slice(0, 12)} @ ${e.path}`).join(' | ')
        : 'installed_plugins.json 裡找不到 spec-pipeline entry —— 若這台裝過 plugin，代表格式變了或 doctor 讀錯層');
  } catch (e) {
    add('plugin_pin', 'WARN', `讀不了 installed_plugins.json：${e.message}`);
  }
} else {
  add('plugin_pin', 'INFO', '沒有 installed_plugins.json（可能是從 repo 直接跑，不是裝好的 plugin）');
}

// ── 7. 選配：真的呼叫一次 codex ─────────────────────────────────────────
// 預設不跑（會花 token）。banner 走 **stderr**，stdout 只有答案 ——
// 所以必須用 spawnSync 取雙串流；execFileSync 只回 stdout，驗不到 model/effort。
if (process.argv.includes('--probe-codex')) {
  const r = spawnSync('codex', [
    '-C', process.cwd(), '-s', 'read-only', '-a', 'never', 'exec',
    '-m', PINNED_MODEL, '-c', `model_reasoning_effort="${PINNED_EFFORT}"`, '-',
  ], { input: '只回答兩個字：ok', encoding: 'utf8' });

  const out = (r.stdout ?? '').trim();
  const err = r.stderr ?? '';
  const okAnswer = out.toLowerCase().includes('ok');
  const okModel = err.includes(`model: ${PINNED_MODEL}`);
  const okEffort = err.includes(`reasoning effort: ${PINNED_EFFORT}`);
  const pass = r.status === 0 && okAnswer && okModel && okEffort;
  add('codex_probe', pass ? 'OK' : 'FAIL',
    `rc=${r.status} answer=${okAnswer} model=${okModel} effort=${okEffort}`
    + (pass ? '' : ` —— 只看 rc 不夠：登入過期、模型不可用、-c 沒生效都可能 rc=0。stderr 首行：${err.split('\n')[0]}`));
} else {
  add('codex_probe', 'SKIP', '加 --probe-codex 才會真的呼叫一次（約 4k tokens）');
}

// ── 輸出 ────────────────────────────────────────────────────────────────
const fails = checks.filter((c) => c.status === 'FAIL');
console.log(JSON.stringify({
  checks,
  summary: {
    fail: fails.length,
    warn: checks.filter((c) => c.status === 'WARN').length,
    verdict: fails.length ? 'NOT_READY' : 'READY',
  },
  boundaries: [
    'doctor 驗的是**環境前提**，不是流程正確性。它綠不代表你的規格或程式碼是對的。',
    'harness 能力（Agent / SendMessage 這類主對話工具）doctor **驗不到** —— 那不在這個行程裡。',
    'skill 散文裡的 shell 片段在 zsh 下的行為，doctor **驗不到**；由 validate-plugin 的 lint 守。',
    '不帶 --probe-codex 時，「codex 裝了」只代表 binary 在 PATH 上，不代表登入有效或模型可用。',
    '兩台機器是否同版本，要**各跑一次**比對 plugin_pin 的 sha —— 單機跑不出這個答案。',
  ],
}, null, 2));
process.exit(fails.length ? 1 : 0);
