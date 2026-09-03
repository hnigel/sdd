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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

/** 讀狀態檔。用來斷言「腳本到底寫了什麼」，不只看 stdout。 */
const state = (dir) => JSON.parse(readFileSync(join(dir, '.claude', 'review-state.json'), 'utf8'));

const TWO_BLOCKERS = BLOCK(
  'B1 BLOCKER a.mjs:12 [FAIL] commit 之後跑 --check -> 基準寫死 HEAD，抓不到差異',
  'B2 BLOCKER a.mjs:40 [FAIL] deny_globs 拼成 denyGlobs -> 整條 deny 靜默失效，敏感路徑拿到 FAST',
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
      const decoy = BLOCK('B1 BLOCKER 這是被倒出來的說明文件裡的範例 [FAIL] x -> y');
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
      const bad = BLOCK('B1 BLOCKER a:1 [FAIL] x -> y', '這行沒有編號');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'h.log', bad));
      assert.equal(r.status, 2);
      assert.match(r.stderr, /不合格式的行/);
    } finally { cleanup(); }
  });

  it('⭐ 編號跳號（輸出被截斷的徵兆）→ rc=2，不得只算看得到的那幾條', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const gap = BLOCK('B1 BLOCKER a:1 [FAIL] x -> y', 'B2 BLOCKER a:2 [FAIL] x -> y', 'B5 BLOCKER a:5 [FAIL] x -> y');
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

  it('--blockers 逃生口仍然可用，但必須帶 --why（明確宣告，可稽核）', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log',
        log(dir, 'l.log', '沒有格式的散文'), '--blockers', '3', '--why', '解析器壞了');
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).blockers, 3);
      const st = state(dir).stages.S3.rounds.at(-1);
      assert.deepEqual(st.manual_override, { declared: 3, why: '解析器壞了' });
    } finally { cleanup(); }
  });

  // ⚠️ 這一組是 2026-09-01 的真實事故：`Number('abc')` = NaN，
  // 而 `Array.from({length: NaN})` = []，於是「rc=0 的任意 log ＋ 一個非數值」
  // 就鑄出一個零 BLOCKER 的放行輪 —— 一個專防假綠的工具自己在鑄綠。
  describe('--blockers 不得鑄出放行輪', () => {
    for (const bad of ['abc', '0', '-1', '1.5', '1e3', '51', ' ', 'NaN']) {
      it(`--blockers ${JSON.stringify(bad)} ⇒ rc=2，且狀態一個位元組都不動`, () => {
        const { dir, cleanup } = sandbox();
        try {
          run(dir, '--start', 'S3', '--task', 't');
          const before = readFileSync(join(dir, '.claude', 'review-state.json'), 'utf8');
          const r = run(dir, '--record', 'S3', '--rc', '0', '--log',
            log(dir, 'l.log', '散文'), '--blockers', bad, '--why', 'x');
          assert.equal(r.status, 2, `拿到 rc=${r.status}: ${r.stdout}${r.stderr}`);
          assert.equal(readFileSync(join(dir, '.claude', 'review-state.json'), 'utf8'), before);
        } finally { cleanup(); }
      });
    }

    it('--blockers 沒帶 --why ⇒ rc=2（人工覆寫必須留下理由）', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        const r = run(dir, '--record', 'S3', '--rc', '0', '--log',
          log(dir, 'l.log', '散文'), '--blockers', '2');
        assert.equal(r.status, 2);
        assert.match(r.stderr, /--why/);
      } finally { cleanup(); }
    });
  });
});

// ⚠️ 舊版把 round 先 push 再判斷，且「零 BLOCKER ⇒ CLEAR」的分支排在上限檢查之前，
// 所以 R3 停下來之後再送一次就成立 R4，上限檢查根本不會執行。
// ⚠️ 輪數上限再機械，只要「重開一個 run」沒有代價，它就形同虛設 ——
// 舊版 --start 只印一行 stderr 就把未收口的 run 蓋掉。
// ⚠️ 狀態檔是「每個專案一份、按 stage 分」，而實際使用會在同一個專案並行跑多件事。
// 舊版 save() 是裸的 writeFileSync：兩個並行的 --record 各寫一輪，
// 最後寫入的無聲覆蓋另一邊。被覆蓋的那輪若帶 BLOCKER，留下的是清空輪 ⇒ 假綠。
describe('⭐⭐ 並行時 fail-closed，不排隊也不搶', () => {
  const LOCK = ['.claude', 'review-state.json.lock'];
  const seed = (dir) => {
    run(dir, '--start', 'S3', '--task', 't');
    run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'l.log', TWO_BLOCKERS));
  };

  for (const args of [
    ['--start', 'S3', '--task', 'B', '--force', '--why', 'x'],
    ['--record', 'S3', '--rc', '0', '--log', 'l.log'],
    ['--resolve', 'S3', '--item', 'B1', '--how', 'x'],
  ]) {
    it(`鎖存在時 ${args[0]} ⇒ rc=2 且狀態逐位元組不變`, () => {
      const { dir, cleanup } = sandbox();
      try {
        seed(dir);
        writeFileSync(join(dir, ...LOCK), '{"pid":99999}');
        const before = readFileSync(join(dir, '.claude', 'review-state.json'), 'utf8');
        const r = run(dir, ...args);
        assert.equal(r.status, 2, `${args[0]} 拿到 rc=${r.status}`);
        assert.match(r.stderr, /正被另一個行程使用/);
        assert.equal(readFileSync(join(dir, '.claude', 'review-state.json'), 'utf8'), before);
      } finally { cleanup(); }
    });
  }

  it('讀取指令不受鎖影響（--status 不改狀態，不該被擋）', () => {
    const { dir, cleanup } = sandbox();
    try {
      seed(dir);
      writeFileSync(join(dir, ...LOCK), '{"pid":99999}');
      assert.equal(run(dir, '--status', 'S3').status, 0);
    } finally { cleanup(); }
  });

  it('正常結束不留殘留鎖，也不留 .tmp', () => {
    const { dir, cleanup } = sandbox();
    try {
      seed(dir);
      const left = readdirSync(join(dir, '.claude')).filter((f) => /\.lock$|\.tmp/.test(f));
      assert.deepEqual(left, []);
    } finally { cleanup(); }
  });

  // ⚠️ 這條是 2026-09-01 實作鎖時當場踩到的 bug：
  // `finally` 擋不住 `process.exit()`，而這些腳本到處用 exit 表達 rc ——
  // 只靠 finally 會把鎖漏在磁碟上，下一個指令就被自己卡住。
  it('走 exit 路徑（rc≠0）也要釋放鎖，不能把自己鎖死', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const l = log(dir, 'l.log', TWO_BLOCKERS);
      run(dir, '--record', 'S3', '--rc', '0', '--log', l);
      run(dir, '--record', 'S3', '--rc', '0', '--log', l);
      // R3 觸發 exit(20)
      assert.equal(run(dir, '--record', 'S3', '--rc', '0', '--log', l).status, 20);
      assert.deepEqual(readdirSync(join(dir, '.claude')).filter((f) => /\.lock$/.test(f)), [],
        'exit(20) 之後不得留下鎖');
      // usage() 的 exit(2) 路徑同理
      assert.equal(run(dir, '--resolve', 'S3', '--item', 'B99', '--how', 'x').status, 2);
      assert.deepEqual(readdirSync(join(dir, '.claude')).filter((f) => /\.lock$/.test(f)), [],
        'exit(2) 之後不得留下鎖');
    } finally { cleanup(); }
  });

  it('鎖釋放後回復正常', () => {
    const { dir, cleanup } = sandbox();
    try {
      seed(dir);
      writeFileSync(join(dir, ...LOCK), '{"pid":99999}');
      assert.equal(run(dir, '--resolve', 'S3', '--item', 'B1', '--how', 'x').status, 2);
      rmSync(join(dir, ...LOCK));
      assert.equal(run(dir, '--resolve', 'S3', '--item', 'B1', '--how', 'x').status, 0);
    } finally { cleanup(); }
  });
});

describe('⭐⭐ 重開 run 要留痕', () => {
  const seed = (dir) => {
    run(dir, '--start', 'S3', '--task', 'A');
    run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'l.log', TWO_BLOCKERS));
  };

  it('未收口時普通 --start ⇒ rc=2，且狀態逐位元組不變', () => {
    const { dir, cleanup } = sandbox();
    try {
      seed(dir);
      const before = readFileSync(join(dir, '.claude', 'review-state.json'), 'utf8');
      const r = run(dir, '--start', 'S3', '--task', 'B');
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /--force/);
      assert.equal(readFileSync(join(dir, '.claude', 'review-state.json'), 'utf8'), before);
    } finally { cleanup(); }
  });

  it('--force 沒帶 --why ⇒ rc=2', () => {
    const { dir, cleanup } = sandbox();
    try {
      seed(dir);
      const r = run(dir, '--start', 'S3', '--task', 'B', '--force');
      assert.equal(r.status, 2);
      assert.match(r.stderr, /--why/);
    } finally { cleanup(); }
  });

  it('--force --why ⇒ 放行，並留下 restarted_over（含被蓋掉的 open_ids 與理由）', () => {
    const { dir, cleanup } = sandbox();
    try {
      seed(dir);
      const r = run(dir, '--start', 'S3', '--task', 'B', '--force', '--why', '換方法');
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const ro = state(dir).stages.S3.restarted_over;
      assert.equal(ro.task, 'A');
      assert.equal(ro.rounds, 1);
      assert.deepEqual(ro.open_ids, ['B1', 'B2']);
      assert.equal(ro.why, '換方法');
    } finally { cleanup(); }
  });

  // force restart 之後 rounds 是空的 —— 若守衛只看 rounds，
  // 第二次普通 --start 就會把上面那筆痕跡無聲洗掉。
  it('force 重開後，第二次普通 --start 仍被擋（痕跡不會被無聲洗掉）', () => {
    const { dir, cleanup } = sandbox();
    try {
      seed(dir);
      run(dir, '--start', 'S3', '--task', 'B', '--force', '--why', 'x');
      const r = run(dir, '--start', 'S3', '--task', 'C');
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.equal(state(dir).stages.S3.restarted_over.task, 'A');
    } finally { cleanup(); }
  });

  it('零有效輪但 invocation-retry 用盡（STOP 狀態）也要 --force', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 'A');
      const bad = log(dir, 'b.log', TWO_BLOCKERS);
      run(dir, '--record', 'S3', '--rc', '1', '--log', bad);   // CLI 失敗，不算一輪
      run(dir, '--record', 'S3', '--rc', '1', '--log', bad);
      assert.equal(state(dir).stages.S3.rounds.length, 0);
      const r = run(dir, '--start', 'S3', '--task', 'B');
      assert.equal(r.status, 2, r.stdout + r.stderr);
    } finally { cleanup(); }
  });

  it('乾淨狀態下 --start 不需要 --force', () => {
    const { dir, cleanup } = sandbox();
    try {
      assert.equal(run(dir, '--start', 'S3', '--task', 'A').status, 0);
    } finally { cleanup(); }
  });
});

describe('⭐⭐ 輪數上限不可繞過', () => {
  it('達上限後再 --record ⇒ rc=20，且狀態逐位元組不變', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      const l = log(dir, 'l.log', TWO_BLOCKERS);
      run(dir, '--record', 'S3', '--rc', '0', '--log', l);           // R1
      run(dir, '--record', 'S3', '--rc', '0', '--log', l);           // R2
      run(dir, '--record', 'S3', '--rc', '0', '--log', l);           // R3 ⇒ 20
      const before = readFileSync(join(dir, '.claude', 'review-state.json'), 'utf8');

      // 空哨兵區塊 —— 舊版會判 CLEAR 並放行
      const clear = log(dir, 'c.log', BLOCK());
      const r = run(dir, '--record', 'S3', '--rc', '0', '--log', clear);
      assert.equal(r.status, 20, `拿到 rc=${r.status}: ${r.stdout}${r.stderr}`);
      assert.equal(state(dir).stages.S3.rounds.length, 3);
      assert.equal(readFileSync(join(dir, '.claude', 'review-state.json'), 'utf8'), before);
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
      const out = JSON.parse(r3.stdout);
      assert.match(out.note, /交給 owner 裁決/);
      // ⚠️ 這個停點問的必須是**編輯的問題**（哪幾條夠格擋關），
      // 不是計數器的問題（還要不要再審一輪）——後者預設了「再審會更好」。
      assert.ok(Array.isArray(out.ask_owner) && out.ask_owner.length >= 3);
      assert.ok(out.ask_owner.some((q) => /擋住出貨|擋關/.test(q)), '要問「哪幾條夠格擋關」');
      assert.ok(out.ask_owner.some((q) => /不要預設/.test(q)), '要明講不預設再審一輪會更好');
      assert.ok(Array.isArray(out.trajectory) && out.trajectory.length === 3, '要附軌跡供裁決');
    } finally { cleanup(); }
  });

  it('軌跡：new_citations 算出「這一輪指了幾個先前沒指過的位置」', () => {
    const { dir, cleanup } = sandbox();
    try {
      run(dir, '--start', 'S3', '--task', 't');
      run(dir, '--record', 'S3', '--rc', '0', '--log',
        log(dir, 'a.log', BLOCK('B1 BLOCKER a.mjs:10 [FAIL] x -> y')));
      run(dir, '--resolve', 'S3', '--item', 'B1', '--how', 'x');
      // 同一個位置 ⇒ 0 個新引用（原地繞）
      run(dir, '--record', 'S3', '--rc', '0', '--log',
        log(dir, 'b.log', BLOCK('B1 BLOCKER a.mjs:10 [FAIL] p -> q')));
      run(dir, '--resolve', 'S3', '--item', 'B1', '--how', 'y');
      // 全新位置 ⇒ 1 個新引用（上一輪的修訂長出了新表面）
      run(dir, '--record', 'S3', '--rc', '0', '--log',
        log(dir, 'c.log', BLOCK('B1 BLOCKER z.mjs:99 [FAIL] m -> n')));
      const tj = JSON.parse(run(dir, '--status', 'S3').stdout).trajectory;
      assert.deepEqual(tj.map((x) => x.new_citations), [1, 0, 1]);
    } finally { cleanup(); }
  });

  describe('⭐⭐ 發散提示：R2 就講，不必等 R3 的停點', () => {
    // LEDGER §2 的判準：一次修訂讓 findings 沒下降、而且全打在新位置上
    // ⇒ 發散的是**修訂**不是審查。等到 R3 停點才印，那一輪修訂就白做了。
    const FRESH_R2 = BLOCK(
      'B1 BLOCKER new.mjs:10 [FAIL] a -> b',
      'B2 BLOCKER new.mjs:20 [FAIL] c -> d',
      'B3 BLOCKER new.mjs:30 [FAIL] e -> f',
    );

    it('R2 全打新位置且 findings 沒下降 → NEEDS_FIX 帶 divergence_hint', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'r1.log', TWO_BLOCKERS));
        run(dir, '--resolve', 'S3', '--item', 'B1', '--how', '加了一層 new.mjs');
        run(dir, '--resolve', 'S3', '--item', 'B2', '--how', '加了一層 new.mjs');
        const r2 = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'r2.log', FRESH_R2));

        assert.equal(r2.status, 0, r2.stdout + r2.stderr);
        const out = JSON.parse(r2.stdout);
        assert.equal(out.verdict, 'NEEDS_FIX', '提示不得改變 verdict');
        assert.ok(out.divergence_hint, 'R2 就該講，不是等 R3');
        assert.match(out.divergence_hint.means, /發散的是/);
        assert.match(out.divergence_hint.do, /該拆該減/);
        assert.match(out.divergence_hint.note, /不是閘門/);
        assert.ok(Array.isArray(out.trajectory), '提示要附軌跡才看得出形狀');
      } finally { cleanup(); }
    });

    it('提示不是閘門：exit code 與狀態檔都不因它改變', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 's1.log', TWO_BLOCKERS));
        run(dir, '--resolve', 'S3', '--item', 'B1', '--how', 'x');
        run(dir, '--resolve', 'S3', '--item', 'B2', '--how', 'y');
        const r2 = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 's2.log', FRESH_R2));
        assert.equal(r2.status, 0);
        assert.ok(JSON.parse(r2.stdout).divergence_hint);
        // 提示是輸出，不入檔 —— 狀態檔裡不該多出任何一個欄位
        const st = state(dir).stages.S3;
        assert.equal(st.rounds.length, 2, '輪數照常增加');
        assert.ok(!JSON.stringify(st).includes('divergence'), '提示不得寫進狀態檔');
      } finally { cleanup(); }
    });

    it('原地繞（打同一批位置）→ 不提示，那不是發散', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 't1.log', TWO_BLOCKERS));
        run(dir, '--resolve', 'S3', '--item', 'B1', '--how', 'x');
        run(dir, '--resolve', 'S3', '--item', 'B2', '--how', 'y');
        const r2 = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 't2.log', TWO_BLOCKERS));
        assert.equal(r2.status, 0);
        assert.ok(!JSON.parse(r2.stdout).divergence_hint, '同一批位置是原地繞，不是長出新表面');
      } finally { cleanup(); }
    });

    it('findings 有下降 → 不提示，那正在收斂', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'u1.log', FRESH_R2));
        for (const i of ['B1', 'B2', 'B3']) run(dir, '--resolve', 'S3', '--item', i, '--how', 'x');
        // 全新位置，但條數 3 → 1
        const r2 = run(dir, '--record', 'S3', '--rc', '0', '--log',
          log(dir, 'u2.log', BLOCK('B1 BLOCKER other.mjs:5 [FAIL] a -> b')));
        assert.equal(r2.status, 0);
        assert.ok(!JSON.parse(r2.stdout).divergence_hint, 'findings 下降就是在收斂，不該叫人拆');
      } finally { cleanup(); }
    });

    it('R1 不提示（沒有前輪可比，引用當然全新）', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        const r1 = run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'v1.log', TWO_BLOCKERS));
        assert.equal(r1.status, 0);
        assert.ok(!JSON.parse(r1.stdout).divergence_hint);
      } finally { cleanup(); }
    });
  });

  describe('⭐⭐ 複審規則由腳本帶下去，不靠模型記得', () => {
    it('prompt-block 一定帶「只報 BLOCKER、不要新 POLISH」與輪次', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'w1.log', TWO_BLOCKERS));
        const b = run(dir, '--prompt-block', 'S3');
        assert.equal(b.status, 0, b.stderr);
        assert.match(b.stdout, /R2（複審輪）/, '要講明這是第幾輪的複審');
        assert.match(b.stdout, /只報 BLOCKER 級別/);
        assert.match(b.stdout, /不要提出新的 POLISH/);
        assert.match(b.stdout, /不要重新發散/);
        // 自相矛盾檢查：既然不收新 POLISH，就不能同時叫它「沒有 BLOCKER 就列 P 行」
        assert.ok(!/沒有 BLOCKER 就只列 P 行/.test(b.stdout), '同一份 prompt 不得自相矛盾');
        assert.match(b.stdout, /留空/);
        // FORMAT_SPEC 是 R1/R2 共用的格式來源，裡面留著 P1 行 ⇒ 複審輪要明講那只是示意
        assert.match(b.stdout, /格式示意/, '範本的 P1 行不關掉，規則 1 就形同虛設');
        assert.match(b.stdout, /<<<FINDINGS>>>/, '格式要求仍要帶下去');
      } finally { cleanup(); }
    });

    it('輪次會跟著走：R2 之後產生的是 R3 的規則', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        const l = log(dir, 'x1.log', TWO_BLOCKERS);
        run(dir, '--record', 'S3', '--rc', '0', '--log', l);
        run(dir, '--record', 'S3', '--rc', '0', '--log', l);
        assert.match(run(dir, '--prompt-block', 'S3').stdout, /R3（複審輪）/);
      } finally { cleanup(); }
    });

    it('effort 指示走 stderr —— stdout 是要整段貼進 prompt 的素材', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'y1.log', TWO_BLOCKERS));
        const b = run(dir, '--prompt-block', 'S3');
        assert.match(b.stderr, /model_reasoning_effort/, 'effort 是呼叫端旗標，給操作者看');
        assert.match(b.stderr, /medium/);
        assert.ok(!/model_reasoning_effort/.test(b.stdout),
          '不得污染 stdout —— 把「請用 medium」貼給 Codex 沒有任何作用');
      } finally { cleanup(); }
    });
  });

  describe('⭐⭐ BLOCKER 必須講得出失效情境', () => {
    it('B 行缺 [FAIL] ⇒ rc=2，不做寬容降級', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        const r = run(dir, '--record', 'S3', '--rc', '0', '--log',
          log(dir, 'n.log', BLOCK('B1 BLOCKER a.mjs:12 這裡好像怪怪的')));
        assert.equal(r.status, 2, r.stdout + r.stderr);
        assert.match(r.stderr, /\[FAIL\]/);
      } finally { cleanup(); }
    });

    it('[FAIL] 但缺 -> 也不算（欄位要有形狀，不是有字就好）', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        const r = run(dir, '--record', 'S3', '--rc', '0', '--log',
          log(dir, 'o.log', BLOCK('B1 BLOCKER a.mjs:12 [FAIL] 就是會壞')));
        assert.equal(r.status, 2);
      } finally { cleanup(); }
    });

    it('POLISH 不需要 [FAIL]（分級的意義就在這）', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        const r = run(dir, '--record', 'S3', '--rc', '0', '--log',
          log(dir, 'p.log', BLOCK('P1 POLISH 命名可以更好')));
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(JSON.parse(r.stdout).verdict, 'CLEAR');
      } finally { cleanup(); }
    });

    it('格式要求會被帶進下一輪的 prompt（單一來源，不會漂移）', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'q.log', TWO_BLOCKERS));
        assert.match(run(dir, '--prompt-block', 'S3').stdout, /\[FAIL\]/);
      } finally { cleanup(); }
    });
  });

  describe('⭐⭐ C1-6：green_allowed 是弱訊號時要講（提示，不是閘門）', () => {
    it('最後一輪有 BLOCKER 且全部 resolve → 印弱訊號，但 green_allowed 仍是 true', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'wa.log', TWO_BLOCKERS));
        run(dir, '--resolve', 'S3', '--item', 'B1', '--how', 'x');
        run(dir, '--resolve', 'S3', '--item', 'B2', '--how', 'y');
        const r = run(dir, '--status', 'S3');
        assert.equal(r.status, 0, '提示不得改變 exit code');
        const s = JSON.parse(r.stdout);
        assert.equal(s.green_allowed, true, '⚠️ 提示不得改變 green_allowed 的值');
        assert.match(s.green_is_weak_signal, /未經複審輪確認/);
        assert.match(s.green_is_weak_signal, /不是閘門/);
      } finally { cleanup(); }
    });

    it('最後一輪本來就零 BLOCKER → 不印（那不是自我回報，是真的沒事）', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        run(dir, '--record', 'S3', '--rc', '0', '--log',
          log(dir, 'wb.log', BLOCK('P1 POLISH 命名')));
        const s = JSON.parse(run(dir, '--status', 'S3').stdout);
        assert.equal(s.green_allowed, true);
        assert.ok(!s.green_is_weak_signal, '零 BLOCKER 的 CLEAR 輪不該被打成弱訊號');
      } finally { cleanup(); }
    });

    it('還有未收口的 → 不印（那根本不能 GREEN，不需要弱訊號提示）', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        run(dir, '--record', 'S3', '--rc', '0', '--log', log(dir, 'wc.log', TWO_BLOCKERS));
        run(dir, '--resolve', 'S3', '--item', 'B1', '--how', 'x');
        const s = JSON.parse(run(dir, '--status', 'S3').stdout);
        assert.equal(s.green_allowed, false);
        assert.ok(!s.green_is_weak_signal);
      } finally { cleanup(); }
    });
  });

  describe('⭐ C7：log 的 sha256 與位元組數（純 metadata，不是閘門）', () => {
    it('log_sha256 與 node crypto 實算一致', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        const l = log(dir, 'sha.log', TWO_BLOCKERS);
        run(dir, '--record', 'S3', '--rc', '0', '--log', l);
        const want = createHash('sha256').update(readFileSync(l)).digest('hex');
        const r = state(dir).stages.S3.rounds[0];
        assert.equal(r.log_sha256, want);
        assert.equal(r.log_sha256.length, 64, '要完整 64 hex，不是截斷');
      } finally { cleanup(); }
    });

    it('非 ASCII 的 log：log_bytes > 字元數（存的是位元組不是字元）', () => {
      const { dir, cleanup } = sandbox();
      try {
        run(dir, '--start', 'S3', '--task', 't');
        const l = log(dir, 'cjk.log', BLOCK(
          'B1 BLOCKER 中文檔名.mjs:12 [FAIL] 並行寫入 -> 狀態檔互相覆寫，收口紀錄消失'));
        run(dir, '--record', 'S3', '--rc', '0', '--log', l);
        const r = state(dir).stages.S3.rounds[0];
        assert.equal(r.log_bytes, readFileSync(l).length);
        assert.ok(r.log_bytes > readFileSync(l, 'utf8').length,
          '中文 log 的位元組數必須大於字元數，否則存的是字元數');
      } finally { cleanup(); }
    });
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
