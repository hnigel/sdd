#!/usr/bin/env node
/**
 * spec-freeze.mjs — 凍結的規格是唯一驗收依據，而「回去改規格」要便宜
 *
 * ## 這支存在的理由
 * 監督者六條職責的第 6 條是「規格錯了 ⇒ 回 S2 改規格再走」，
 * 而 skill 自己標註它**特別容易違反** —— 因為就地改實作比較省事。
 *
 * 但那不是紀律問題，是**成本問題**：規格是一份 `design-<日期>.md` 整份文件，
 * 改它要重寫、重審整份。誠實的路比偷懶的路貴十倍時，規則就是在跟人性對賭。
 *
 * ⇒ 抄 OpenSpec 的想法：**變更是對一份活規格的 delta**。
 *   `--revise` 一個指令做完「附理由 + 產生 delta + 重新凍結」，
 *   然後 S3 只複審 **delta**，不是整份重審。誠實的路變成最便宜的路。
 *
 * ## 另一半：偵測反向的失敗
 * 第 6 條的反面更隱蔽 —— **把規格偷偷改成符合實作**。
 * 那會讓下一輪 review 拿一份被追認過的規格來審，然後理所當然地通過。
 * `--check` 就是在抓這個：規格動了但沒經過 `--revise` ⇒ SPEC_DRIFT。
 *
 * ## 指令
 *   --freeze <spec>              S3 GREEN 之後凍結
 *   --check                      規格還是凍結的那一份嗎？
 *   --revise <spec> --why "..."  誠實地改規格：產生 delta、重新凍結
 *   --delta                      印出最近一次 revise 的 delta（貼進 S3 複審的 prompt）
 *
 * ## 退出碼
 *   0  = OK
 *   2  = 使用方式錯誤
 *   10 = 還沒凍結（**不是錯誤**）
 *   20 = SPEC_DRIFT：規格被改過但沒走 --revise ⇒ 停下來
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const ROOT = process.cwd();
const STATE = path.join(ROOT, '.claude', 'spec-freeze.json');
const REVIEW_STATE = path.join(ROOT, '.claude', 'review-state.json');

function usage(msg) {
  console.error(`spec-freeze: ${msg}`);
  console.error(`用法:
  spec-freeze.mjs --freeze <spec.md> [--force --why "<理由>"]
  spec-freeze.mjs --check
  spec-freeze.mjs --revise <spec.md> --why "<為什麼規格要改>"
  spec-freeze.mjs --delta`);
  process.exit(2);
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null);
function save(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}

/** 用 git diff --no-index 產生 unified diff —— 不自己重造 diff 演算法。 */
function unifiedDiff(before, after, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-'));
  const a = path.join(dir, 'frozen.md');
  const b = path.join(dir, 'revised.md');
  fs.writeFileSync(a, before);
  fs.writeFileSync(b, after);
  try {
    // 相同時 rc=0 且無輸出；不同時 rc=1 並把 diff 印在 stdout ⇒ 要接住 rc=1
    execFileSync('git', ['diff', '--no-index', '--unified=3', '--', a, b], { encoding: 'utf8' });
    return '';
  } catch (e) {
    if (e.status === 1) {
      // git 的 `a/` `b/` 前綴後面直接接絕對路徑（斜線是路徑自己的），
      // 所以替換時要保留前導斜線，否則會變成 `adesign.md`
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return String(e.stdout)
        .replace(new RegExp(esc(a), 'g'), `/${label}`)
        .replace(new RegExp(esc(b), 'g'), `/${label}`);
    }
    throw e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** S3 還有未收口的 BLOCKER 就不該凍結 —— 「S3 不 GREEN 不進 Step 4」。 */
function assertS3Clear() {
  if (!fs.existsSync(REVIEW_STATE)) {
    // 「沒有狀態檔」不是可以放行的例外，是**沒有通過的證據**。
    console.error('spec-freeze: 沒有 .claude/review-state.json ⇒ 無法確認 S3 收口了沒，不得凍結。');
    console.error('「S3 不 GREEN 不進 Step 4」—— 先跑一輪 review 再來。');
    process.exit(20);
  }
  const st = JSON.parse(fs.readFileSync(REVIEW_STATE, 'utf8')).stages?.S3;
  if (!st || !st.rounds.length) {
    console.error('spec-freeze: review-state 裡 S3 沒有任何有效的一輪 ⇒ S3 尚未通過，不得凍結。');
    console.error('「S3 不 GREEN 不進 Step 4」—— 先跑一輪 review 再來。');
    process.exit(20);
  }
  const open = (st.rounds[st.rounds.length - 1].blockers ?? []).filter((b) => !b.resolved);
  if (open.length) {
    console.error(`spec-freeze: S3 還有 ${open.length} 條未收口（${open.map((b) => b.id).join(', ')}）⇒ 不得凍結。`);
    console.error('「S3 不 GREEN 不進 Step 4」—— 先把它們收掉。');
    process.exit(20);
  }
}

function freeze(spec, force, why) {
  if (!spec || !fs.existsSync(spec)) usage(`--freeze 需要存在的規格檔（找不到 ${spec}）`);
  const content = fs.readFileSync(spec, 'utf8');
  const prev = load();

  // ⚠️ 重新 freeze 是 SPEC_DRIFT 的免費出口。
  // 舊版：改完規格不走 --revise，直接再 --freeze 一次，就用**凍結之前**那一輪
  // 清空輪重新祝福新內容，順便把 revisions 清成空的 ⇒ --check 從此回 OK。
  // 那一輪審的是舊內容，新內容沒有被任何人看過。
  // ⇒ 用已經存好的 sha 做內容綁定：內容變了就不准重新凍結，去走 --revise。
  if (prev && prev.sha !== sha(content)) {
    if (!force) {
      console.error('spec-freeze: 已經凍結過，而且規格內容已經改變 ⇒ 不得重新凍結。');
      console.error(`  已凍結：${prev.spec} sha=${prev.sha}（${prev.frozen_at}）`);
      console.error(`  現在的：${spec} sha=${sha(content)}`);
      console.error('  ⚠️ 重新凍結會用「改動之前」那一輪的清空狀態去祝福改動之後的內容，');
      console.error('     而那一輪根本沒看過新內容 —— 這正是 SPEC_DRIFT 要擋的事。');
      console.error('  要改規格請走：--revise <規格檔> --why "<為什麼要改>"');
      console.error('  真的是換一份全新的規格（不是修訂）才用：--freeze <檔> --force --why "<理由>"');
      process.exit(20);
    }
    if (!why) usage('--force 需要 --why "<為什麼丟掉舊的凍結>"');
  }

  assertS3Clear();
  const discarded = prev && prev.sha !== sha(content) ? {
    at: new Date().toISOString(),
    spec: prev.spec, sha: prev.sha, frozen_at: prev.frozen_at,
    revisions: prev.revisions?.length ?? 0, why,
  } : undefined;

  save({
    version: 1,
    spec: path.relative(ROOT, path.resolve(spec)),
    sha: sha(content),
    frozen_at: new Date().toISOString(),
    content,
    revisions: [],
    ...(discarded ? { discarded_freeze: discarded } : {}),
  });
  console.log(JSON.stringify({ spec, sha: sha(content), note: '規格已凍結 —— 從這裡開始，它是唯一驗收依據' }, null, 2));
}

function check() {
  const s = load();
  if (!s) { console.error('spec-freeze: 還沒凍結任何規格'); process.exit(10); }
  const p = path.join(ROOT, s.spec);
  if (!fs.existsSync(p)) {
    console.log(JSON.stringify({ verdict: 'SPEC_DRIFT', why: `凍結的規格 ${s.spec} 不見了` }, null, 2));
    process.exit(20);
  }
  const now = sha(fs.readFileSync(p, 'utf8'));
  if (now !== s.sha) {
    console.log(JSON.stringify({
      verdict: 'SPEC_DRIFT',
      spec: s.spec,
      frozen: s.sha,
      now,
      why: '規格被改過，但沒有走 --revise',
      note: '⚠️ 最隱蔽的失敗形狀就是「把規格改成符合實作」—— 那會讓下一輪 review 拿一份被追認過的規格來審。'
        + '要嘛還原，要嘛用 --revise --why 走一次，讓這次修改被記錄並重新過 S3。',
    }, null, 2));
    process.exit(20);
  }
  console.log(JSON.stringify({
    verdict: 'OK', spec: s.spec, sha: now, revisions: s.revisions.length,
  }, null, 2));
}

function revise(spec, why) {
  if (!why) usage('--revise 需要 --why "<為什麼規格要改>"（沒有理由的規格修改，下一輪沒人講得清楚）');
  const s = load();
  if (!s) { console.error('spec-freeze: 還沒凍結任何規格 —— 先 --freeze'); process.exit(10); }
  const target = spec ?? s.spec;
  const p = path.resolve(ROOT, target);
  if (!fs.existsSync(p)) usage(`找不到 ${target}`);
  const after = fs.readFileSync(p, 'utf8');
  const delta = unifiedDiff(s.content, after, s.spec);
  if (!delta) { console.error('spec-freeze: 規格沒有任何變化 —— 沒東西要 revise'); process.exit(2); }

  const n = s.revisions.length + 1;
  s.revisions.push({ n, at: new Date().toISOString(), why, delta });
  s.content = after;
  s.sha = sha(after);
  save(s);
  console.log(JSON.stringify({
    revision: `第 ${n} 次`, spec: s.spec, sha: s.sha, why,
    next: '用 --delta 取出這次的 delta，**只把 delta 送去 S3 複審**，不要整份重審',
  }, null, 2));
}

function showDelta() {
  const s = load();
  if (!s) { console.error('spec-freeze: 還沒凍結任何規格'); process.exit(10); }
  const r = s.revisions[s.revisions.length - 1];
  if (!r) { console.error('spec-freeze: 規格從凍結之後沒有改過 —— 沒有 delta'); process.exit(10); }
  console.log(`## 規格修訂 #${r.n} —— 只審這段 delta

**為什麼要改**：${r.why}

⚠️ 這是對**已經通過 S3 的規格**做的修改。請只針對這段 delta 判斷：
1. 這個改動本身有沒有問題？
2. 它有沒有讓規格與先前已收口的項目衝突？

\`\`\`diff
${r.delta.trim()}
\`\`\``);
}

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
switch (argv[0]) {
  case '--freeze': freeze(argv[1], argv.includes('--force'), flag('--why')); break;
  case '--check': check(); break;
  case '--revise': revise(argv[1]?.startsWith('--') ? undefined : argv[1], flag('--why')); break;
  case '--delta': showDelta(); break;
  default: usage(`不認得的指令: ${argv[0] ?? '(缺)'}`);
}
