#!/usr/bin/env node
/**
 * validate-plugin.mjs — 這個 repo 自己的形狀檢查（CI 用，不會被裝到使用者機器上）
 *
 * ## 為什麼要有
 * 這個 repo 被同一類 bug 咬過很多次：**兩份東西漂移，而且沒有訊號**。
 *   - `plugin.json` 的描述還寫著早就刪掉的 `/sdd`
 *   - skill 叫人去跑 `/codex-review`，但那個斜線指令不存在
 *   - `deny_globs` 拼錯 ⇒ 整條 deny 靜默失效
 * 前兩個是「文字指向一個不存在的東西」，第三個是「鍵名沒人驗」。
 * ⇒ 全部都可以機械檢查，就不要靠人記得。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../plugins/spec-pipeline/scripts/lib/validate-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errs = [];
const bad = (m) => errs.push(m);
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// ── 1. marketplace 與 plugin 的版本要一致 ──────────────────────────────
const market = readJson('.claude-plugin/marketplace.json');
for (const entry of market.plugins) {
  const dir = path.join(ROOT, entry.source);
  const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) { bad(`marketplace 指到 ${entry.source}，但那裡沒有 plugin.json`); continue; }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== entry.name) bad(`${entry.name}: marketplace 與 plugin.json 的 name 不一致（${entry.name} vs ${manifest.name}）`);
  if (manifest.version !== entry.version) bad(`${entry.name}: 版本不一致（marketplace ${entry.version} vs plugin.json ${manifest.version}）`);

  // ── 2. frontmatter ──────────────────────────────────────────────────
  const fm = (file) => {
    const t = fs.readFileSync(file, 'utf8');
    const m = t.match(/^---\n([\s\S]*?)\n---/);
    return m ? Object.fromEntries(m[1].split('\n').filter((l) => l.includes(':'))
      .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()])) : null;
  };
  const rel = (f) => path.relative(ROOT, f);

  /**
   * skill 裡的 shell 片段是給模型照抄執行的，但沒有任何東西在守它 ——
   * 直到 2026-09-01 才發現兩份 SKILL.md 共 14 行用 `RS="node ..."` 然後 `$RS --flag`，
   * 那要 shell 對未加引號的展開做分詞：bash 會，**zsh 預設不會**，而 macOS 預設是 zsh。
   * 這個 lint 守的是**已知的不可攜模式**，不是完備性證明。
   * 只掃 bash/sh 標記的 fenced block —— 其他語言的 `$VAR` 開頭是合法的。
   */
  function lintShell(file, label) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let inShell = false;
    lines.forEach((line, i) => {
      const fence = /^\s*```\s*(\S*)/.exec(line);
      if (fence) { inShell = inShell ? false : /^(bash|sh|shell|zsh)$/.test(fence[1]); return; }
      if (!inShell) return;
      // 裸的純量展開當命令用：`$RS --status`
      if (/^\s*\$[A-Za-z_][A-Za-z0-9_]*(\s|$)/.test(line)) {
        bad(`${label}:${i + 1} 用 \`${line.trim().slice(0, 40)}\` 這種 \`$VAR --flag\` 寫法 `
          + '—— zsh 預設不分詞，macOS 會原樣失敗。改用 shell function：`rs() { node "…" "$@"; }`');
      }
    });
  }

  const skillsDir = path.join(dir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const s of fs.readdirSync(skillsDir)) {
      const f = path.join(skillsDir, s, 'SKILL.md');
      if (!fs.existsSync(f)) { bad(`${rel(path.join(skillsDir, s))} 沒有 SKILL.md`); continue; }
      const meta = fm(f);
      if (!meta) { bad(`${rel(f)} 沒有 frontmatter`); continue; }
      if (!meta.name) bad(`${rel(f)} frontmatter 缺 name`);
      else if (meta.name !== s) bad(`${rel(f)} 的 name「${meta.name}」與目錄名「${s}」不一致`);
      if (!meta.description) bad(`${rel(f)} frontmatter 缺 description`);
      lintShell(f, rel(f));
    }
  }
  const cmdDir = path.join(dir, 'commands');
  if (fs.existsSync(cmdDir)) {
    for (const c of fs.readdirSync(cmdDir).filter((f) => f.endsWith('.md'))) {
      const f = path.join(cmdDir, c);
      const meta = fm(f);
      if (!meta?.description) bad(`${rel(f)} frontmatter 缺 description`);
      // 宣告了會吃參數，就一定要有佔位符，否則任務描述會掉在地上
      if (meta?.['argument-hint'] && !fs.readFileSync(f, 'utf8').includes('$ARGUMENTS')) {
        bad(`${rel(f)} 有 argument-hint 卻沒有 $ARGUMENTS`);
      }
    }
  }

  // ── 3. 文字裡指到的腳本要真的存在 ───────────────────────────────────
  // 「skill 叫你跑一個不存在的東西」是這個 repo 最常見的漂移形狀
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(dir).filter((f) => f.endsWith('.md'))) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)) {
      if (!fs.existsSync(path.join(dir, m[1]))) bad(`${rel(f)} 指到不存在的 ${m[1]}`);
    }
  }

  // ── 3b. 文字裡指到的**章節**要真的存在 ──────────────────────────────
  /**
   * 第 3 項的同一個形狀，另一種面孔：不是指到不存在的**檔案**，
   * 是指到自己文件裡不存在的**段落**。
   *
   * 2026-09-03 真的發生了：把 codex-review SKILL 的「三條曾經寫錯的事實」整節
   * 搬去 LEDGER 之後，同一份文件裡兩處「見下方「三條曾經寫錯的事實」」
   * 就變成指向空氣 —— 而當時的檢查只認 `${CLAUDE_PLUGIN_ROOT}/` 開頭的腳本路徑，
   * 一個字都沒說。**刪一節比改一節容易，忘記清理指標是必然，不是偶然。**
   *
   * 只認**帶「」的**指標：實測全 plugin 只有三處，三處都是真的章節引用，零誤報。
   * 不帶引號的（「見下方表」「見下方第 6 條」）刻意不管 —— 那些機械上判不了，
   * 硬要判就會製造雜訊，而雜訊會讓人開始忽略這個檢查。
   */
  const SECTION_REF = /[詳參]?見[下上]?[方節]?「([^」]{1,40})」/g;
  for (const f of walk(dir).filter((f) => f.endsWith('.md'))) {
    const text = fs.readFileSync(f, 'utf8');
    const headings = text.split('\n').filter((l) => /^#{1,6}\s/.test(l));
    for (const m of text.matchAll(SECTION_REF)) {
      if (!headings.some((h) => h.includes(m[1]))) {
        bad(`${rel(f)} 指到不存在的章節「${m[1]}」—— 那一節被改名或刪掉了，指標沒跟著清`);
      }
    }
  }

  // ── 3c. 承重段落不得消失 ────────────────────────────────────────────
  /**
   * `spec-pipeline/SKILL.md` 是**唯一**承載這幾件事的地方：F0 fail-closed、S0 分級、
   * 監督者六責任、GREEN 的必要條件。它們不在任何腳本裡，刪掉不會有任何測試變紅。
   *
   * 2026-09-05 的異廠商審查（S3 R1 的 B7）指出：規劃中的「把 skill 切薄成 runner 入口」
   * 只要求「使用者預設路徑只有 runner」，沒有界定薄化邊界 ⇒
   * **FULL 任務可能不再收到這四件事，而引用檢查與版本檢查照樣通過。**
   *
   * ⇒ 現在就把它釘住，不等那一天。這只驗**標題還在**，不判斷內容好壞 ——
   * 判斷品質就回到散文了。要改標題就要同時改這裡，那正是我們要的訊號。
   */
  /**
   * ⚠️ **只驗「關鍵字還在」不夠**（2026-09-05 S3 R2 指出）：
   * 薄化時把標題留著、正文刪光，一樣通過 —— 那正是這道守衛要擋的事。
   * ⇒ 每一項再加一個 `body`：那段**底下**必須還有幾行實質內容。
   * 純行數，不判斷內容好壞（判品質就回到散文了）。
   */
  const LOAD_BEARING = {
    'skills/spec-pipeline/SKILL.md': [
      { need: /^#+.*F0/m, what: 'F0 快路判定（fail-closed 的入口）', body: 12 },
      { need: /^#+.*S0 triage/m, what: 'S0 分級', body: 10 },
      { need: /^#+.*規劃者 = 監督者/m, what: '監督者六責任', body: 15 },
      { need: /^#+.*GREEN 的必要條件/m, what: 'GREEN 的必要條件', body: 3 },
      { need: /^#+.*S4 實作/m, what: 'S4 之後的 scope 重驗（--verify-scope）', body: 6 },
      { need: /^#+.*S5 Codex 審程式碼/m, what: 'S5：verify_cmd 與 spec-freeze --check 的操作契約', body: 6 },
      { need: /spec-freeze\.mjs.*--freeze|--freeze.*spec-freeze\.mjs/, what: '凍結規格的呼叫' },
      { need: /verify_cmd/, what: 'verify_cmd 的角色' },
    ],
    'skills/codex-review/SKILL.md': [
      { need: /<<<FINDINGS>>>/, what: '哨兵區塊契約' },
      { need: /\[FAIL\]/, what: 'BLOCKER 必須講得出失效情境' },
    ],
  };
  for (const [relPath, needles] of Object.entries(LOAD_BEARING)) {
    const f = path.join(dir, relPath);
    if (!fs.existsSync(f)) { bad(`承重檔案不見了：${relPath}`); continue; }
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split('\n');
    for (const { need, what, body } of needles) {
      const m = need.exec(text);
      if (!m) {
        bad(`${relPath} 少了承重段落「${what}」—— 它沒有別的來源，刪掉不會有任何測試變紅。`
          + '\n    真的要移除或改名，請同時改 validate-plugin 的 LOAD_BEARING，讓下一個人看得到這個決定。');
        continue;
      }
      if (!body) continue;
      // 從命中的那一行往下數，到下一個同級或更高級標題為止，有幾行實質內容
      const at = text.slice(0, m.index).split('\n').length - 1;
      const level = (/^(#+)/.exec(lines[at]) ?? [, '###'])[1].length;
      let n = 0;
      for (let i = at + 1; i < lines.length; i++) {
        const h = /^(#+)\s/.exec(lines[i]);
        if (h && h[1].length <= level) break;
        if (lines[i].trim()) n++;
      }
      if (n < body) {
        bad(`${relPath} 的承重段落「${what}」只剩 ${n} 行實質內容（至少要 ${body}）——`
          + '\n    標題留著、正文被掏空，跟刪掉是一樣的效果。');
      }
    }
  }

  // ── 4. schema 與範例 ────────────────────────────────────────────────
  const schemaPath = path.join(dir, 'schemas', 'pipeline.schema.json');
  if (fs.existsSync(schemaPath)) {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const examplePath = path.join(dir, 'schemas', 'pipeline.example.json');
    if (!fs.existsSync(examplePath)) bad('有 schema 卻沒有 pipeline.example.json（範例要能被驗，不然又是一份會漂移的文件）');
    else {
      const e = validate(JSON.parse(fs.readFileSync(examplePath, 'utf8')), schema);
      if (e.length) bad(`pipeline.example.json 過不了自己的 schema：${e.join('；')}`);
    }
  }
}

if (errs.length) {
  console.error(`validate-plugin: ${errs.length} 個問題`);
  for (const e of errs) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('validate-plugin ✅ 全部通過');
