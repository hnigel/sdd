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
