#!/usr/bin/env node
/**
 * fast-eligibility.mjs — F0：這個任務可不可以跳過 S0–S3 直接進實作？
 *
 * 規劃：`plan/new_skill/design-v3-2026-08-31.md` §1「F0 fast-eligibility」
 *
 * ## 為什麼一定要是腳本，不能寫在 Markdown 裡
 * 「純樣式／局部常數／單一 symbol／test-only」這四個詞**都可以自我說服**。
 * 寫成 command 的散文，實際做判斷的還是模型 —— 那就不是 deterministic。
 * codex review 舉的四個反例（都符合字面 allowlist、但都不該走 fast）：
 *   - 「純樣式」：`display:none` 可以藏掉整個功能
 *   - 「局部常數」：價格常數改一個數字就是經濟改動
 *   - 「單一 symbol」：共用 symbol 改一處影響全 repo
 *   - 「test-only」：刪掉 assertion 就是把守衛拔掉
 *
 * ## 兩種模式
 *   --check <path...>          進場前判定（S4 之前）
 *   --verify-scope <baseline>  S4 之後按**實際 diff** 重驗
 *
 * ## 退出碼（讓呼叫端好分支）
 *   0  = FAST（可走快路）
 *   10 = FULL（必須走完整流程）—— **不是錯誤**
 *   2  = 使用方式/設定錯誤
 *
 * ⚠️ **任何未知一律 FULL**。這個腳本的預設方向永遠是「不確定就走慢的」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const CONFIG = path.join(ROOT, '.claude', 'pipeline.json');

const MAX_FILES = 2;
const MAX_LINES = 80;   // 新增 + 刪除的總和

/** glob → RegExp。只支援 `**`、`*`、`?`，夠用且行為可預測。 */
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matchAny = (p, globs) => globs.some((g) => globToRe(g).test(p));

function fail(reasons) {
  console.log(JSON.stringify({ verdict: 'full', reasons }, null, 2));
  process.exit(10);
}
function usage(msg) {
  console.error(`fast-eligibility: ${msg}`);
  console.error('用法: fast-eligibility.mjs --check <path...> | --verify-scope <baseline.json>');
  process.exit(2);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG)) return { err: '缺 .claude/pipeline.json' };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
  catch (e) { return { err: `pipeline.json 不是合法 JSON: ${e.message}` }; }
  // fail-closed：缺 verify_cmd 就不可能驗證，也就不可能宣告 GREEN
  if (!cfg.verify_cmd || typeof cfg.verify_cmd !== 'string') return { err: '缺 verify_cmd' };
  const fp = cfg.fast_path;
  if (!fp || !Array.isArray(fp.allow_globs) || fp.allow_globs.length === 0) {
    return { err: '缺 fast_path.allow_globs' };
  }
  return { cfg, allow: fp.allow_globs, deny: Array.isArray(fp.deny_globs) ? fp.deny_globs : [] };
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

// ── 模式 1：進場判定 ────────────────────────────────────────────────────
function check(paths) {
  const reasons = [];
  if (paths.length === 0) usage('--check 需要明確的候選路徑（不接受「自己去找」）');

  const { err, allow, deny } = loadConfig();
  if (err) fail([err]);   // 缺設定 ⇒ FULL，不是 FAST

  if (paths.length > MAX_FILES) reasons.push(`候選檔數 ${paths.length} > ${MAX_FILES}`);

  for (const p of paths) {
    // deny 優先於 allow —— 順序反了就會讓危險路徑因為符合 allow 而過關
    if (matchAny(p, deny)) reasons.push(`${p} 命中 deny_globs`);
    else if (!matchAny(p, allow)) reasons.push(`${p} 不在 allow_globs 內`);
    if (!fs.existsSync(path.join(ROOT, p))) reasons.push(`${p} 不存在（新增檔案一律走 full）`);
  }

  // 入場乾淨：共享 dirty tree 下分不出哪些 diff 屬於本次任務
  let dirty = '';
  try { dirty = git(['status', '--porcelain', '--', ...paths]).trim(); }
  catch (e) { fail([`git status 失敗: ${e.message}`]); }
  if (dirty) reasons.push(`候選路徑入場不乾淨:\n${dirty}`);

  if (reasons.length) fail(reasons);

  // baseline：記下入場時的 blob hash，S4 之後用它算真正屬於本次的 diff
  const head = git(['rev-parse', 'HEAD']).trim();
  // ⚠️ 進場時**既有的** untracked 檔要記下來 —— 否則 S4 之後會把它們誤判成
  //    「入場後新增的 scope 外路徑」。實測時就是這樣紅的（腳本把自己的產物也算進去了）。
  let untrackedAtEntry = [];
  try {
    untrackedAtEntry = git(['ls-files', '--others', '--exclude-standard']).trim().split('\n').filter(Boolean);
  } catch { /* ignore */ }
  const baseline = {
    created_at: new Date().toISOString(),
    head,
    paths,
    max_files: MAX_FILES,
    max_lines: MAX_LINES,
    untracked_at_entry: untrackedAtEntry,
    blobs: Object.fromEntries(paths.map((p) => [p, git(['hash-object', p]).trim()])),
  };
  const out = path.join(ROOT, '.claude', 'fast-baseline.json');
  fs.writeFileSync(out, JSON.stringify(baseline, null, 2));
  console.log(JSON.stringify({ verdict: 'fast', baseline: '.claude/fast-baseline.json', head, paths }, null, 2));
  process.exit(0);
}

// ── 模式 2：S4 之後按實際 diff 重驗 ─────────────────────────────────────
function verifyScope(baselineFile) {
  if (!fs.existsSync(baselineFile)) usage(`找不到 baseline: ${baselineFile}`);
  const b = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const reasons = [];

  // numstat：新增 刪除 路徑。binary 會是 "-\t-\t路徑"
  let numstat = '';
  try { numstat = git(['diff', '--numstat', '--find-renames', 'HEAD', '--']).trim(); }
  catch (e) { fail([`git diff 失敗: ${e.message}`]); }

  const rows = numstat ? numstat.split('\n').map((l) => l.split('\t')) : [];
  const touched = rows.map((r) => r[2]);

  // 入場後新增的 scope 外路徑（含 untracked）一律超界
  let untracked = [];
  try { untracked = git(['ls-files', '--others', '--exclude-standard']).trim().split('\n').filter(Boolean); }
  catch { /* ignore */ }

  // 排除三種**不是本次任務造成**的東西，否則會永遠紅：
  //   ① 候選路徑本身  ② 進場時就已經存在的 untracked  ③ 本腳本自己的產物
  const entryUntracked = new Set(b.untracked_at_entry ?? []);
  const SELF = new Set(['.claude/fast-baseline.json']);
  const outOfScope = [...touched, ...untracked].filter(
    (p) => p && !b.paths.includes(p) && !entryUntracked.has(p) && !SELF.has(p),
  );
  if (outOfScope.length) reasons.push(`scope 外的變更: ${outOfScope.join(', ')}`);

  let total = 0;
  for (const [add, del, p] of rows) {
    if (add === '-' || del === '-') { reasons.push(`${p} 是 binary`); continue; }
    total += Number(add) + Number(del);
  }
  if (rows.some((r) => r[2] && r[2].includes('=>'))) reasons.push('偵測到 rename');
  if (touched.length > b.max_files) reasons.push(`實際改動檔數 ${touched.length} > ${b.max_files}`);
  if (total > b.max_lines) reasons.push(`實際變更行數 ${total}（新增+刪除） > ${b.max_lines}`);

  if (reasons.length) {
    // ⚠️ 超界時**不自動回滾**：diff 是玩家的工作成果，保留它，改走 full retriage
    console.log(JSON.stringify({
      verdict: 'full',
      action: 'stop-implementer; keep-diff; retriage',
      reasons,
    }, null, 2));
    process.exit(10);
  }
  console.log(JSON.stringify({ verdict: 'fast', files: touched.length, lines: total }, null, 2));
  process.exit(0);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === '--check') check(rest);
else if (mode === '--verify-scope') verifyScope(rest[0] ?? path.join(ROOT, '.claude', 'fast-baseline.json'));
else usage('缺 --check 或 --verify-scope');
