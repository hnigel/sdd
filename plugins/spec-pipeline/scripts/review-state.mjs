#!/usr/bin/env node
/**
 * review-state.mjs — Codex review 的**跨 session 操作狀態**
 *
 * ## 這支存在的理由
 * `codex-review` skill 說最有效的手法是「逐項核對上一輪」（實測讓 R1→R5 變成一輪見底），
 * 但流程原本不留任何狀態 ⇒ 換一個 session 就拿不到前輪 findings，
 * 於是 skill 只好寫一句免責聲明：「不得聲稱逐項收口」。
 * **那是用警告標語取代功能** —— 最有效的手法被建在一個會斷的地基上。
 *
 * ## 為什麼輪數也要機械化（跟 F0 同一個理由）
 * 「這算第二輪還第三輪」「這條算不算收口了」「這次 CLI 掛掉算不算一輪」
 * 三句都可以自我說服。散文寫得再清楚，實際數數的還是模型。
 * ⇒ 輪數、停止條件、invocation-retry 預算，全部由這支腳本持有。
 *
 * ## 這**不是** owner 否決的那個 log
 * 被否決的是遙測 / retro / 統計彙總（理由：一個人的使用量在統計上到不了決策點）。
 * 這裡存的是**當前這一 run 的操作狀態**：上一輪講了什麼、我怎麼處理的、現在第幾輪。
 * 不跨 run 彙總、不算趨勢、不產報表。run 結束就沒有價值了。
 *
 * ## 指令
 *   --start <stage> --task "<描述>"              開一個新 run（會覆蓋該 stage 的舊狀態）
 *   --record <stage> --rc <n> --log <file>       記一輪。RC≠0 或回覆空 ⇒ 不算一輪
 *   --resolve <stage> --item <id> --how "<做法>"  記下某條 finding 怎麼處理的
 *   --prompt-block <stage>                       產生下一輪 prompt 要貼的「上輪 findings + 我的處理」
 *   --status <stage>                             現在第幾輪、還有幾條沒收口、可不可以 GREEN
 *
 * ## 退出碼
 *   0  = OK
 *   2  = 使用方式錯誤
 *   10 = 沒有前輪狀態 ⇒ 當成新 run 從初審開始（**不是錯誤**）
 *   20 = STOP_ASK_OWNER（R3 仍有 BLOCKER，或 invocation-retry 用完）
 *   21 = REVIEW_ERROR（RC≠0 或回覆空 ⇒ 這次不算一輪）
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const STATE = path.join(ROOT, '.claude', 'review-state.json');

const MAX_ROUNDS = 3;        // R3 仍有 BLOCKER ⇒ 停下來問 owner
const MAX_INVOCATION_RETRY = 2;  // CLI 失敗另走最多兩次，不佔輪數

function usage(msg) {
  console.error(`review-state: ${msg}`);
  console.error(`用法:
  review-state.mjs --start <stage> --task "<描述>"
  review-state.mjs --record <stage> --rc <n> --log <file> [--blockers <n>]
  review-state.mjs --resolve <stage> --item <id> --how "<做法>"
  review-state.mjs --prompt-block <stage>
  review-state.mjs --status <stage>`);
  process.exit(2);
}

const load = () => (fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, 'utf8'))
  : { version: 1, stages: {} });

function save(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}

/** 取 codex log 的 final response —— 與 codex-review skill 的 awk 同一套規則，只留這一份實作。 */
function finalResponse(logFile) {
  const lines = fs.readFileSync(logFile, 'utf8').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() === 'codex') start = i;
  return (start === -1 ? lines : lines.slice(start + 1)).join('\n').trim();
}

// 「沒有 BLOCKER」這種宣告不是一條 finding
const NEGATED = /(\bno\b|\bnone\b|\bzero\b|沒有|無)\s*[^\n]{0,12}BLOCKER|BLOCKER[^\n]{0,8}[:：]\s*(none|n\/a|無|沒有|0)\s*$/i;

/**
 * 從 final response 抽出 BLOCKER / POLISH。
 * ⚠️ 抓不到任何格式標記時**不假設是零** —— 回 unstructured，逼呼叫端明講。
 */
function parseFindings(text) {
  const lines = text.split('\n');
  const hasMarker = lines.some((l) => /\bBLOCKER\b|\bPOLISH\b/.test(l));
  if (!hasMarker) return { parse: 'unstructured', blockers: [], polish: [] };

  const blockers = [];
  const polish = [];
  let cur = null;
  for (const raw of lines) {
    const l = raw.trim();
    const isB = /\bBLOCKER\b/.test(l) && !NEGATED.test(l);
    const isP = /\bPOLISH\b/.test(l) && !NEGATED.test(l);
    if (isB || isP) {
      cur = { kind: isB ? 'B' : 'P', text: l };
      (isB ? blockers : polish).push(cur);
    } else if (cur && l && !/^[-=_*#]{3,}$/.test(l)) {
      cur.text += `\n${l}`;          // 續行併進上一條
    } else if (!l) {
      cur = null;
    }
  }
  return {
    parse: 'structured',
    blockers: blockers.map((b, i) => ({ id: `B${i + 1}`, text: b.text.trim(), resolved: null })),
    polish: polish.map((p) => p.text.trim()),
  };
}

const stageOf = (s, name) => {
  const st = s.stages[name];
  if (!st) {
    console.error(`review-state: stage "${name}" 沒有狀態 —— 先跑 --start，或當成新 run 從初審開始`);
    process.exit(10);
  }
  return st;
};
const lastRound = (st) => st.rounds[st.rounds.length - 1] ?? null;
const openBlockers = (st) => (lastRound(st)?.blockers ?? []).filter((b) => !b.resolved);

// ── --start ────────────────────────────────────────────────────────────
function start(stage, task) {
  if (!task) usage('--start 需要 --task "<描述>"（用來確認狀態屬於這一 run，不是上一件事的殘留）');
  const s = load();
  const prev = s.stages[stage];
  if (prev && prev.rounds.length) {
    // 不靜默覆蓋：前一 run 沒收完就重開，是要讓人看見的事
    console.error(`⚠️ ${stage} 原本有一個未結束的 run（task: ${prev.task}，已跑 ${prev.rounds.length} 輪，`
      + `${openBlockers(prev).length} 條未收口）—— 已覆蓋。`);
  }
  s.stages[stage] = { task, started_at: new Date().toISOString(), rounds: [], invocation_failures: [] };
  save(s);
  console.log(JSON.stringify({ stage, task, round: 0, next: 'R1 初審' }, null, 2));
}

// ── --record ───────────────────────────────────────────────────────────
function record(stage, rc, logFile, blockersOverride) {
  if (rc === undefined || Number.isNaN(rc)) usage('--record 需要 --rc <n>');
  if (!logFile || !fs.existsSync(logFile)) usage(`--record 需要 --log <file>（找不到 ${logFile}）`);
  const s = load();
  const st = stageOf(s, stage);

  const response = rc === 0 ? finalResponse(logFile) : '';

  // 只有 RC=0 且 final response 完整非空才算一輪有效審查
  if (rc !== 0 || !response) {
    const why = rc !== 0 ? `RC=${rc}` : 'final response 是空的';
    st.invocation_failures.push({ at: new Date().toISOString(), rc, log: logFile, why });
    save(s);
    const used = st.invocation_failures.length;
    const out = {
      verdict: 'REVIEW_ERROR', why,
      note: '這次不算一輪（輪數沒有增加）',
      invocation_retry: `${used}/${MAX_INVOCATION_RETRY}`,
    };
    if (used > MAX_INVOCATION_RETRY) {
      out.verdict = 'STOP_ASK_OWNER';
      out.note = `invocation-retry 已用掉 ${used} 次（上限 ${MAX_INVOCATION_RETRY}）⇒ 停下來問 owner`;
      console.log(JSON.stringify(out, null, 2));
      process.exit(20);
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(21);
  }

  const parsed = parseFindings(response);
  if (parsed.parse === 'unstructured' && blockersOverride === undefined) {
    usage('回覆裡找不到 BLOCKER / POLISH 標記，無法機械判定還有幾條沒收口。\n'
      + '  ⇒ 要嘛把 prompt 改成 BLOCKER/POLISH 兩級格式（codex-review skill 的實測有效模式 1），\n'
      + '     要嘛明講 --blockers <n>。**不會**因為抓不到就當作零。');
  }
  if (blockersOverride !== undefined) {
    parsed.blockers = Array.from({ length: blockersOverride }, (_, i) => ({
      id: `B${i + 1}`, text: '(未結構化，由呼叫端宣告條數)', resolved: null,
    }));
  }

  const n = st.rounds.length + 1;
  st.rounds.push({ n, at: new Date().toISOString(), rc, log: logFile, response, ...parsed });
  save(s);

  const open = parsed.blockers.length;
  const out = { stage, round: `R${n}`, blockers: open, polish: parsed.polish.length, parse: parsed.parse };

  if (open === 0) {
    out.verdict = 'CLEAR';
    out.note = '這一階段無未處理 BLOCKER（GREEN 還要 verify_cmd RC=0）';
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (n >= MAX_ROUNDS) {
    out.verdict = 'STOP_ASK_OWNER';
    out.note = `R${n} 仍有 ${open} 條 BLOCKER（上限 ${MAX_ROUNDS} 輪）⇒ 停下來問 owner，不要再開下一輪`;
    console.log(JSON.stringify(out, null, 2));
    process.exit(20);
  }
  out.verdict = 'NEEDS_FIX';
  out.note = `修完用 --resolve 逐條記下做法，再用 --prompt-block 產生 R${n + 1} 的 prompt`;
  out.items = parsed.blockers.map((b) => b.id);
  console.log(JSON.stringify(out, null, 2));
}

// ── --resolve ──────────────────────────────────────────────────────────
function resolve(stage, item, how) {
  if (!item || !how) usage('--resolve 需要 --item <id> 與 --how "<做法>"');
  const s = load();
  const st = stageOf(s, stage);
  const r = lastRound(st);
  if (!r) usage(`${stage} 還沒有任何一輪`);
  const b = r.blockers.find((x) => x.id === item);
  if (!b) usage(`${stage} R${r.n} 沒有 ${item}（有的是：${r.blockers.map((x) => x.id).join(', ') || '無'}）`);
  b.resolved = { how, at: new Date().toISOString() };
  save(s);
  const open = openBlockers(st);
  console.log(JSON.stringify({ stage, round: `R${r.n}`, resolved: item, still_open: open.map((x) => x.id) }, null, 2));
}

// ── --prompt-block ─────────────────────────────────────────────────────
function promptBlock(stage) {
  const s = load();
  const st = stageOf(s, stage);
  const r = lastRound(st);
  if (!r) {
    console.error(`review-state: ${stage} 還沒有任何一輪 ⇒ 這次就是 R1 初審`);
    process.exit(10);
  }
  const lines = [];
  lines.push(`## 上一輪（R${r.n}）你提出的項目，與我的處理`);
  lines.push('');
  lines.push('⚠️ 請**逐項**確認是否真的收口。沒收口的直接說沒收口，不要重新發散到別的題目。');
  lines.push('');
  for (const b of r.blockers) {
    lines.push(`### ${b.id}（BLOCKER）`);
    lines.push(b.text);
    lines.push('');
    lines.push(b.resolved ? `**我的處理**：${b.resolved.how}` : '**我的處理**：⚠️ 尚未處理');
    lines.push('');
  }
  if (!r.blockers.length) lines.push('（上一輪沒有 BLOCKER）\n');
  lines.push(`### 上一輪的完整回覆（逐字，供你自己核對）`);
  lines.push('');
  lines.push('```');
  lines.push(r.response);
  lines.push('```');
  console.log(lines.join('\n'));
}

// ── --status ───────────────────────────────────────────────────────────
function status(stage) {
  const s = load();
  const st = stageOf(s, stage);
  const r = lastRound(st);
  const open = openBlockers(st);
  console.log(JSON.stringify({
    stage,
    task: st.task,
    rounds_done: st.rounds.length,
    next_round: st.rounds.length >= MAX_ROUNDS ? '(已達上限)' : `R${st.rounds.length + 1}`,
    invocation_retry: `${st.invocation_failures.length}/${MAX_INVOCATION_RETRY}`,
    open_blockers: open.map((b) => b.id),
    green_allowed: Boolean(r) && open.length === 0,
    note: !r ? '還沒有有效的一輪 ⇒ 不得 GREEN'
      : open.length ? `還有 ${open.length} 條未收口 ⇒ 不得 GREEN`
        : '本階段無未處理 BLOCKER（GREEN 仍需 verify_cmd RC=0）',
  }, null, 2));
}

// ── 參數 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const [mode, stage] = argv;
if (!stage || stage.startsWith('--')) usage(`${mode ?? '(缺指令)'} 需要 <stage>（例如 S3 / S5）`);

switch (mode) {
  case '--start': start(stage, flag('--task')); break;
  case '--record': {
    const bo = flag('--blockers');
    record(stage, Number(flag('--rc')), flag('--log'), bo === undefined ? undefined : Number(bo));
    break;
  }
  case '--resolve': resolve(stage, flag('--item'), flag('--how')); break;
  case '--prompt-block': promptBlock(stage); break;
  case '--status': status(stage); break;
  default: usage(`不認得的指令: ${mode}`);
}
