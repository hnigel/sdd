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
 *   --prompt-block <stage>                       產生下一輪 prompt 要貼的「複審規則 + 上輪 findings + 我的處理」
 *                                                （stdout = 貼進 prompt 的素材；stderr = 給操作者的 effort 指示）
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
import crypto from 'node:crypto';
import { withLock, atomicWrite } from './lib/state-lock.mjs';

const ROOT = process.cwd();
const STATE = path.join(ROOT, '.claude', 'review-state.json');

const MAX_ROUNDS = 3;        // R3 仍有 BLOCKER ⇒ 停下來問 owner
const MAX_INVOCATION_RETRY = 2;  // CLI 失敗另走最多兩次，不佔輪數
const MAX_MANUAL_BLOCKERS = 50;  // --blockers 的上界。下界是 1：不得人工宣告「沒問題」

function usage(msg) {
  console.error(`review-state: ${msg}`);
  console.error(`用法:
  review-state.mjs --start <stage> --task "<描述>" [--force --why "<為什麼重開>"]
  review-state.mjs --record <stage> --rc <n> --log <file> [--blockers <n> --why "<理由>"]
  review-state.mjs --resolve <stage> --item <id> --how "<做法>"
  review-state.mjs --prompt-block <stage>
  review-state.mjs --status <stage>`);
  process.exit(2);
}

const load = () => (fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, 'utf8'))
  : { version: 1, stages: {} });

function save(s) { atomicWrite(STATE, JSON.stringify(s, null, 2)); }

/** 改狀態的指令一律包在鎖裡。拿不到鎖 ⇒ rc=2 fail-closed，不排隊、不搶。 */
const mutating = (fn) => withLock(STATE, fn, (msg) => usage(msg));

/**
 * ⚠️ **不要解析散文。**
 *
 * 舊版是「含 BLOCKER 字樣的行 = 一條 finding」。三種真實情況全部失敗：
 *   ① Codex 照 skill 建議的格式輸出「**BLOCKER** 標題 + **B1**…**B6** 條目」
 *      ⇒ 只數到標題，六條算成一條
 *   ② log 裡 final message 出現兩次 ⇒ 那一條又變成兩條
 *   ③ Codex 用 `nl -ba` 把原始碼倒進 log，而原始碼註解裡就有 BLOCKER 字樣
 *      ⇒ 實測一份真實 log 數出 **19 條**，沒有一條是真的 finding
 *
 * 三種的方向都可能偏低 ⇒ 收口兩條就 green_allowed:true。
 * **一個專門防假綠的工具自己在製造假綠。**
 *
 * ⇒ 改成契約：Codex 必須輸出一個帶哨兵的區塊，這裡**只認那個區塊**。
 *   認不出來就拒絕，絕不猜、絕不因為抓不到就當作零。
 */
const BEGIN = '<<<FINDINGS>>>';
const END = '<<<END-FINDINGS>>>';

export const FORMAT_SPEC = `${BEGIN}
B1 BLOCKER 檔案:行號 [FAIL] 什麼輸入或狀態 -> 什麼錯誤結果
B2 BLOCKER 檔案:行號 [FAIL] 什麼輸入或狀態 -> 什麼錯誤結果
P1 POLISH 一行標題，不要展開
${END}

⚠️ 每條 BLOCKER 都必須帶 \`[FAIL] <輸入或狀態> -> <錯誤結果>\`。
講不出具體觸發情境的，請自己降級成 POLISH —— 那不是懲罰，是分級。
（腳本只檢查這個欄位**存在**，不判斷內容好壞。）`;

/**
 * 取**最後一個**哨兵區塊。
 * 為什麼是最後一個：Codex 可能在工具輸出裡把含有這個格式的檔案倒出來（例如這份 skill
 * 自己的說明），那些一定出現在中間；真正的回答一定在最後。
 */
function findingsBlock(text) {
  const b = text.lastIndexOf(BEGIN);
  if (b === -1) return null;
  const e = text.indexOf(END, b);
  if (e === -1) return null;
  return text.slice(b + BEGIN.length, e).trim();
}

const ITEM = /^(B|P)(\d+)\s+(BLOCKER|POLISH)\s+(.+)$/;
/** BLOCKER 的失效情境欄位。只驗形狀：有 [FAIL]，且其後有一個 -> 分隔。 */
const FAIL_FIELD = /\[FAIL\][^\n]*->/;

/**
 * 解析區塊內容。**任何不合契約的地方都回 error，不做寬容處理。**
 * 寬容 = 猜 = 回到當初出事的地方。
 */
function parseFindings(text) {
  const block = findingsBlock(text);
  if (block === null) return { error: 'no-block' };

  const blockers = [];
  const polish = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = ITEM.exec(line);
    if (!m) return { error: `區塊裡有不合格式的行：${JSON.stringify(line.slice(0, 80))}` };
    const [, kind, num, level, desc] = m;
    if ((kind === 'B') !== (level === 'BLOCKER')) {
      return { error: `編號與等級對不上：${JSON.stringify(line.slice(0, 80))}（B* 必須是 BLOCKER，P* 必須是 POLISH）` };
    }
    // ⚠️ Verification bar：BLOCKER 必須講得出具體失效情境。
    // 講不出「什麼輸入 → 什麼錯誤結果」的，多半是偏好或推測，不是會出事的缺陷。
    // 這裡**只驗欄位存在**，不判斷內容好壞 —— 判斷品質就回到散文了。
    // （不做寬容降級：審查者自己說過，靜默把 BLOCKER 改寫成 POLISH 會讓真缺陷消失。）
    if (kind === 'B' && !FAIL_FIELD.test(desc)) {
      return { error: `${kind}${num} 缺 [FAIL] 欄位：${JSON.stringify(line.slice(0, 80))}\n`
        + '  BLOCKER 必須寫成 `[FAIL] <什麼輸入或狀態> -> <什麼錯誤結果>`；講不出來的請降級為 POLISH' };
    }
    (kind === 'B' ? blockers : polish).push({ n: Number(num), desc });
  }

  // 編號必須是 1..n 連續且不重複 —— 跳號通常代表輸出被截斷，那會讓計數偏低
  for (const [name, arr] of [['B', blockers], ['P', polish]]) {
    const ns = arr.map((x) => x.n).sort((a, b) => a - b);
    for (let i = 0; i < ns.length; i++) {
      if (ns[i] !== i + 1) {
        return { error: `${name} 的編號不是 1..${ns.length} 連續（拿到 ${ns.join(',')}）—— 輸出可能被截斷` };
      }
    }
  }

  return {
    block,
    blockers: blockers.sort((a, b) => a.n - b.n)
      .map((x) => ({ id: `B${x.n}`, text: x.desc, resolved: null })),
    polish: polish.sort((a, b) => a.n - b.n).map((x) => x.desc),
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

/** 從 finding 文字裡抽出 `檔案:行號` 這種引用。純字串處理，不判斷語意。 */
const citations = (text) => new Set((text.match(/[\w./@-]+:\d+(?:-\d+)?/g) ?? []));

/**
 * 每輪的「新引用」數 —— 這一輪的 findings 指向的位置，有幾個是先前各輪都沒指過的。
 *
 * ⚠️ 這**不是**收斂判定，是給人看的軌跡。它回答的是
 * 「審查者還在開新戰場，還是在原地繞」——那是編輯要的資訊，不是閘門。
 * 一輪的 findings 全部指向前面沒出現過的位置，通常代表上一輪的修訂長出了新表面。
 */
function trajectory(st) {
  const seen = new Set();
  return st.rounds.map((r) => {
    const cited = citations([...(r.blockers ?? []).map((b) => b.text), ...(r.polish ?? [])].join('\n'));
    const fresh = [...cited].filter((c) => !seen.has(c));
    for (const c of cited) seen.add(c);
    return {
      round: `R${r.n}`,
      blockers: (r.blockers ?? []).length,
      polish: (r.polish ?? []).length,
      cited: cited.size,
      new_citations: fresh.length,
      ...(r.manual_override ? { manual_override: true } : {}),
    };
  });
}

/**
 * 「發散的是修訂，不是審查」的機械訊號 —— **提示，不是閘門**。
 *
 * LEDGER §2 的可操作判準：*一次修訂讓規格變長、而 findings 沒下降 ⇒ 該拆該減，
 * 不是該再審一輪*。腳本量不到「變長」（target 不在它手上），但量得到同一件事的
 * 另一面：**這一輪指的位置全部是先前沒指過的**。
 *
 * run1 實測正是這個形狀：R2 打新機制 4/4、R3 打新機制 5/5，findings 穩在 4–5 條，
 * 行數每輪 +38 —— 兩個速率都沒下降，那不是收斂，是穩態。
 *
 * ⚠️ 只在 R2 起算（R1 沒有前輪可比，它的引用當然全新）。
 * ⚠️ 不改 verdict、不改 exit code、不進狀態檔。理由見 LEDGER §4：閘門一律留在腳本，
 *    而這一條的判準裡有「該拆該減」——那是編輯的價值判斷，腳本不做。
 */
function divergence(st) {
  const tj = trajectory(st);
  if (tj.length < 2) return null;
  const cur = tj[tj.length - 1];
  const prev = tj[tj.length - 2];
  const curTotal = cur.blockers + cur.polish;
  const prevTotal = prev.blockers + prev.polish;
  // 三個條件同時成立才提示：有引用、引用全新、findings 沒下降
  if (!cur.cited || cur.new_citations !== cur.cited || curTotal < prevTotal) return null;
  return {
    signal: `${cur.round} 的 ${cur.cited} 個引用位置**全部**是先前各輪沒指過的，`
      + `而 findings 沒有下降（${prev.round} ${prevTotal} → ${cur.round} ${curTotal}）`,
    means: '這一輪打的是上一輪為了收口而新加的東西 ⇒ 發散的是**修訂**，不是審查。',
    do: '該拆該減，不是再審一輪。優先考慮刪掉那個機制、縮小 review target、'
      + '或誠實記為已知缺口 —— 再加一層只會多一片沒審過的表面。',
    note: '這是提示，不是閘門。verdict 與 exit code 都沒有因為它改變。',
  };
}

// ── --start ────────────────────────────────────────────────────────────
/**
 * 前一個 run 是不是「還沒交代完」—— 三種都算，因為三種都代表有未了結的東西：
 *   ① 跑過輪次（不論收口與否）
 *   ② 本身就是一次 force restart 的結果（否則第二次普通 --start 就把痕跡洗掉了）
 *   ③ invocation-retry 已用盡（零有效輪，但那是 STOP 狀態，不是乾淨起點）
 */
function unfinished(prev) {
  if (!prev) return null;
  if (prev.rounds?.length) return `已跑 ${prev.rounds.length} 輪，${openBlockers(prev).length} 條未收口`;
  if (prev.restarted_over) return '本身是一次 --force 重開的結果，痕跡還在';
  if ((prev.invocation_failures?.length ?? 0) >= MAX_INVOCATION_RETRY) {
    return `invocation-retry 已用盡（${prev.invocation_failures.length}/${MAX_INVOCATION_RETRY}）⇒ STOP 狀態`;
  }
  return null;
}

function start(stage, task, force, why) {
  if (!task) usage('--start 需要 --task "<描述>"（用來確認狀態屬於這一 run，不是上一件事的殘留）');
  const s = load();
  const prev = s.stages[stage];
  const why_unfinished = unfinished(prev);

  // ⚠️ 舊版只印一行 stderr 就覆蓋。那等於讓「重開一個 run」變成繞過輪數上限的
  // 免費出口 —— 停止條件再機械，只要重置沒有代價就形同虛設。
  if (why_unfinished) {
    if (!force) {
      console.error(`review-state: ${stage} 有一個未結束的 run（task: ${prev.task}；${why_unfinished}）。`);
      console.error('要覆蓋它請明講：--start ' + stage + ' --task "…" --force --why "<為什麼重開>"');
      console.error('⚠️ 重開會把輪數歸零。如果只是想繼續，直接 --record 就好，不要 --start。');
      process.exit(2);
    }
    if (!why) usage('--force 需要 --why "<為什麼重開>"（沒有理由的重置，下一個人講不清楚發生過什麼）');
  }

  const carried = why_unfinished ? {
    at: new Date().toISOString(),
    task: prev.task,
    rounds: prev.rounds?.length ?? 0,
    open_ids: openBlockers(prev).map((b) => b.id),
    why,
    reason: why_unfinished,
  } : undefined;

  s.stages[stage] = {
    task,
    started_at: new Date().toISOString(),
    rounds: [],
    invocation_failures: [],
    ...(carried ? { restarted_over: carried } : {}),
  };
  save(s);
  console.log(JSON.stringify({
    stage, task, round: 0, next: 'R1 初審',
    ...(carried ? { restarted_over: carried } : {}),
  }, null, 2));
}

// ── --record ───────────────────────────────────────────────────────────
function record(stage, rc, logFile, blockersOverride) {
  if (rc === undefined || Number.isNaN(rc)) usage('--record 需要 --rc <n>');
  if (!logFile || !fs.existsSync(logFile)) usage(`--record 需要 --log <file>（找不到 ${logFile}）`);
  const s = load();
  const st = stageOf(s, stage);

  // ⚠️ 入場守衛：輪數上限要在**讀 log 之前**擋，而且一個位元組都不寫。
  // 舊版把 round 先 push 再判斷，且「零 BLOCKER ⇒ CLEAR」的分支排在上限檢查之前 ——
  // 於是 R3 停下來之後再送一次就成立 R4，上限檢查根本不會執行。
  if (st.rounds.length >= MAX_ROUNDS) {
    console.log(JSON.stringify({
      stage,
      rounds_done: st.rounds.length,
      verdict: 'STOP_ASK_OWNER',
      note: `已達輪數上限 ${MAX_ROUNDS} ⇒ 停下來問 owner。這次沒有被記錄，狀態未變動。`,
    }, null, 2));
    process.exit(20);
  }
  // C7（v7 出貨項）—— 讀成 Buffer，一次拿到內容、sha256 與**位元組**長度。
  // ⚠️ `log_bytes` 要的是 raw byte 長度（Buffer.length），不是字元數 ——
  //    非 ASCII 的 log 兩者不同，而 codex 的 log 一定有中文。
  const buf = fs.readFileSync(logFile);
  const raw = buf.toString('utf8');

  const reviewError = (why, note) => {
    st.invocation_failures.push({ at: new Date().toISOString(), rc, log: logFile, why });
    save(s);
    const used = st.invocation_failures.length;
    const out = {
      verdict: 'REVIEW_ERROR', why,
      note: note ?? '這次不算一輪（輪數沒有增加）',
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
  };

  // 只有 RC=0 且 log 非空才可能是一輪有效審查
  if (rc !== 0) reviewError(`RC=${rc}`);
  if (!raw.trim()) reviewError('log 是空的');

  let parsed;
  if (blockersOverride !== undefined) {
    // 明確宣告的逃生口：呼叫端自己說有幾條。可見、可稽核，但不是預設路徑。
    // 值域已在參數解析處驗過（1..MAX_MANUAL_BLOCKERS 的安全整數 ＋ 必帶 --why）。
    parsed = {
      block: `(未使用哨兵區塊，由呼叫端宣告 ${blockersOverride.n} 條；理由：${blockersOverride.why})`,
      blockers: Array.from({ length: blockersOverride.n }, (_, i) => ({
        id: `B${i + 1}`, text: '(由呼叫端宣告，無內容)', resolved: null,
      })),
      polish: [],
    };
  } else {
    parsed = parseFindings(raw);
    if (parsed.error === 'no-block') {
      // ⚠️ 這裡**不能**當作零。可能是 review 沒跑完，也可能是 prompt 沒帶格式要求 ——
      //    兩種都代表「這次沒有拿到可用的結果」，都不得計為一輪、更不得放行。
      reviewError(
        `log 裡找不到 ${BEGIN} 區塊`,
        '兩種可能：① review 沒跑完 ② prompt 沒要求哨兵格式。'
        + `把這段放進 prompt 的結尾要求：\n${FORMAT_SPEC}\n`
        + '真的要手動宣告條數就用 --blockers <n>（不會因為抓不到就當作零）',
      );
    }
    if (parsed.error) {
      usage(`哨兵區塊格式不合：${parsed.error}\n  正確格式：\n${FORMAT_SPEC}`);
    }
  }

  const n = st.rounds.length + 1;
  st.rounds.push({
    n, at: new Date().toISOString(), rc, log: logFile,
    // ⚠️ 純 metadata，**不是閘門**。`log` 存的是揮發的 mktemp 路徑，run 結束就沒了；
    //    這兩個欄位讓「當時記的是哪一份 log」事後還對得上。
    //    ⚠️ 這**不宣稱**解掉 G4（log 無 provenance）—— mtime 版死過（D8），
    //    內容雜湊一樣證明不了「這份 log 是這一輪剛跑出來的」。
    log_sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    log_bytes: buf.length,
    findings_block: parsed.block,
    blockers: parsed.blockers,
    polish: parsed.polish,
    ...(blockersOverride ? { manual_override: { declared: blockersOverride.n, why: blockersOverride.why } } : {}),
  });
  save(s);

  const open = parsed.blockers.length;
  const out = { stage, round: `R${n}`, blockers: open, polish: parsed.polish.length };

  if (open === 0) {
    out.verdict = 'CLEAR';
    out.note = '這一階段無未處理 BLOCKER（GREEN 還要 verify_cmd RC=0）';
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (n >= MAX_ROUNDS) {
    // ⚠️ 這裡要問的是**編輯的問題**，不是計數器的問題。
    // 「還要不要再審一輪」預設了「再審會更好」；但審查者對看過的東西是收斂的，
    // 撐住 findings 數的是每輪修訂新增的材料 —— 再審一輪只會審到更年輕的東西。
    // owner 在這個流程裡就是編輯：該由他裁決「剩下這幾條夠不夠格擋關」。
    out.verdict = 'STOP_ASK_OWNER';
    out.trajectory = trajectory(st);
    out.note = `R${n} 仍有 ${open} 條 BLOCKER（上限 ${MAX_ROUNDS} 輪）⇒ 交給 owner 裁決。`;
    out.ask_owner = [
      `逐條看這 ${open} 條：哪幾條**夠格擋住出貨**？（要能講出「什麼輸入 → 什麼錯誤結果」的才算）`,
      '不夠格的，記為已知缺口並附繞過路徑 —— 誠實記載比留一道擋不住的閘好。',
      '看 trajectory 的 new_citations：若每輪都在指新位置，發散的是**修訂**不是審查 ⇒ 該拆該減，不是再審。',
      '不要預設「再審一輪會更好」。',
    ];
    console.log(JSON.stringify(out, null, 2));
    process.exit(20);
  }
  out.verdict = 'NEEDS_FIX';
  out.note = `修完用 --resolve 逐條記下做法，再用 --prompt-block 產生 R${n + 1} 的 prompt`;
  out.items = parsed.blockers.map((b) => b.id);
  // ⚠️ 這個訊號在 R2 就成立了，不必等 R3 的停點才知道。等到停點才印，
  //    等於讓那一輪修訂白做 —— 它會照著同一個形狀再長出一片新表面。
  const div = divergence(st);
  if (div) {
    out.divergence_hint = div;
    out.trajectory = trajectory(st);
  }
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
  // ⚠️ 走到這裡代表至少已經有一輪 ⇒ 下一輪必然是 R2 或更後面，**複審規則一定成立**。
  // 這兩條規則原本只寫在 skill 的散文裡，靠模型自己記得寫進 prompt ——
  // 而腳本明明知道現在第幾輪。那正是這個 repo 到處在罰的安排（散文 = 沒有人在守）。
  // 外部前案：Claude Code 官方 REVIEW.md 的 re-review convergence，原文說這條可以
  // "stop a one-line fix from reaching round seven on style alone"。
  const next = r.n + 1;
  const lines = [];
  lines.push(`## 本輪是 R${next}（複審輪）—— 先讀規則，再讀項目`);
  lines.push('');
  lines.push(`1. **只報 BLOCKER 級別。不要提出新的 POLISH。**`);
  lines.push('2. **逐項**確認上一輪那些項目是否真的收口。沒收口的直接說沒收口。');
  lines.push('3. 除了上面那些項目、以及「為了收口而新加的東西」之外，**不要重新發散到別的題目**。');
  lines.push('4. BLOCKER 一樣必須帶 `[FAIL] <什麼輸入或狀態> -> <什麼錯誤結果>`；講不出來的不要報。');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`## 上一輪（R${r.n}）你提出的項目，與我的處理`);
  lines.push('');
  for (const b of r.blockers) {
    lines.push(`### ${b.id}（BLOCKER）`);
    lines.push(b.text);
    lines.push('');
    lines.push(b.resolved ? `**我的處理**：${b.resolved.how}` : '**我的處理**：⚠️ 尚未處理');
    lines.push('');
  }
  if (!r.blockers.length) lines.push('（上一輪沒有 BLOCKER）\n');
  lines.push('### 上一輪的 findings 區塊（逐字，供你自己核對）');
  lines.push('');
  lines.push('```');
  lines.push(r.findings_block ?? '(無)');
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### ⚠️ 本輪輸出格式（必須照做，否則結果無法被機械判讀）');
  lines.push('');
  lines.push('回覆的**最後**要附上這個區塊，一條一行，編號從 1 連續：');
  lines.push('');
  lines.push('```');
  lines.push(FORMAT_SPEC);
  lines.push('```');
  lines.push('');
  // 複審輪不收新 POLISH（上面規則 1）⇒ 這裡不能再叫它「沒有 BLOCKER 就列 P 行」，
  // 否則同一份 prompt 自相矛盾，而模型會挑對它比較省事的那一句。
  // FORMAT_SPEC 本身不改 —— 它是 R1/R2 共用的**格式**單一來源，動它會讓 R1 收不到 POLISH。
  lines.push('⚠️ 上面範本裡的 `P1` 行只是**格式示意**。本輪不收新 POLISH（規則 1）⇒ **不要列 P 行**。');
  lines.push('');
  lines.push('沒有 BLOCKER 就讓區塊**留空**（保留頭尾兩行），**不要省略區塊本身**。');
  console.log(lines.join('\n'));

  // ⚠️ effort 是呼叫端的旗標，不是 prompt 內容 ⇒ 走 stderr 給操作者，不要污染 stdout。
  // stdout 是要整段貼進 prompt 的素材；把「請用 medium」貼給 Codex 沒有任何作用。
  console.error(`review-state: 下一輪是 R${next}（複審輪）⇒ `
    + 'codex 的 model_reasoning_effort 要比上一輪降一級，且不高於 medium。\n'
    + '  理由：low/medium 只報最有信心的 findings，high 以上會包含它自己也不確定的。'
    + '第一輪要廣，之後要準。');
}

// ── --status ───────────────────────────────────────────────────────────
function status(stage) {
  const s = load();
  const st = stageOf(s, stage);
  const r = lastRound(st);
  const open = openBlockers(st);

  /**
   * C1-6（v7 出貨項）—— `green_allowed` 是**弱訊號**時多印一行。
   *
   * ⚠️ **這不是閘門。** 不改 `green_allowed` 的值、不改 exit code、不寫狀態檔。
   *
   * 為什麼要有：`green_allowed` 的收口判定是自我回報 —— `--resolve` 把最後一輪的
   * BLOCKER 全部標記完，**不需要任何複審輪**就會變 true（F1）。真實操作者靠人工
   * 否決過它（F10 逐字：「green_allowed: true 只是『六條都已標記處理』，不代表通過」）。
   *
   * 六輪審查證明「怎麼判定 GREEN」那一層尚未收斂（三版機制全被打掉，其一還是審查者
   * 自提後自行撤回），所以**不修語意，只補訊號**。強行立一道擋不住的閘比沒有閘更糟。
   *
   * 與死路 D3（時間 proxy）的差別：這裡不看時間，看的是「最後一輪有 BLOCKER 且
   * 全部 resolved」這個**已經在狀態檔裡的事實**。
   */
  const weakGreen = Boolean(r) && open.length === 0 && (r.blockers ?? []).length > 0;

  console.log(JSON.stringify({
    stage,
    task: st.task,
    rounds_done: st.rounds.length,
    next_round: st.rounds.length >= MAX_ROUNDS ? '(已達上限)' : `R${st.rounds.length + 1}`,
    invocation_retry: `${st.invocation_failures.length}/${MAX_INVOCATION_RETRY}`,
    open_blockers: open.map((b) => b.id),
    trajectory: trajectory(st),
    green_allowed: Boolean(r) && open.length === 0,
    ...(weakGreen ? {
      green_is_weak_signal: '已全部標記處理，但**未經複審輪確認** —— green_allowed 是弱訊號，'
        + `建議再送一輪複審（\`--prompt-block ${stage}\` 產生素材），拿到零 BLOCKER 或 STOP 之後再凍結。`
        + '（這不是閘門，green_allowed 的值沒有因為這行改變；見 design-green-semantics）',
    } : {}),
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
  case '--start': mutating(() => start(stage, flag('--task'), argv.includes('--force'), flag('--why'))); break;
  case '--record': {
    const bo = flag('--blockers');
    let override;
    if (bo !== undefined) {
      // ⚠️ Number('abc') = NaN，而 Array.from({length: NaN}) = [] ——
      // 舊版因此讓「rc=0 的任意 log ＋ 一個非數值」鑄出零 BLOCKER 的放行輪。
      const n = Number(bo);
      if (!Number.isSafeInteger(n) || n < 1 || n > MAX_MANUAL_BLOCKERS) {
        usage(`--blockers 只收 1..${MAX_MANUAL_BLOCKERS} 的整數（拿到 ${JSON.stringify(bo)}）`
          + ' —— 你可以人工宣告有幾條，但永遠不能人工宣告沒問題');
      }
      const why = flag('--why');
      if (!why) usage('--blockers 需要 --why "<為什麼不走哨兵區塊>"（人工覆寫必須留下理由）');
      override = { n, why };
    }
    mutating(() => record(stage, Number(flag('--rc')), flag('--log'), override));
    break;
  }
  case '--resolve': mutating(() => resolve(stage, flag('--item'), flag('--how'))); break;
  case '--prompt-block': promptBlock(stage); break;
  case '--status': status(stage); break;
  default: usage(`不認得的指令: ${mode}`);
}
