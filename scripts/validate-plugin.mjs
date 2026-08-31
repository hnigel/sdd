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
