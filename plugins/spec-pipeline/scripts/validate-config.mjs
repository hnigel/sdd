#!/usr/bin/env node
/**
 * validate-config.mjs — 照 schema 檢查 `.claude/pipeline.json`
 *
 * `fast-eligibility` 進場時本來就會驗，但那是**跑起來才知道**。
 * 這支讓人可以在設定完之後立刻驗，也讓 CI 驗得到。
 * 兩邊讀的是同一份 `schemas/pipeline.schema.json`。
 *
 * 退出碼：0 = 通過、2 = 設定有問題、10 = 沒有這個檔（fail-closed，不是錯誤）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './lib/validate-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'schemas', 'pipeline.schema.json'), 'utf8'));
const target = process.argv[2] ?? path.join(process.cwd(), '.claude', 'pipeline.json');

if (!fs.existsSync(target)) {
  console.error(`缺 ${target} ⇒ fail-closed：只允許規劃與唯讀檢查，不得 GREEN`);
  process.exit(10);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(target, 'utf8')); }
catch (e) { console.error(`${target} 不是合法 JSON: ${e.message}`); process.exit(2); }

const errs = validate(cfg, SCHEMA);
if (errs.length) {
  console.error(`${target} 有 ${errs.length} 個問題：`);
  for (const e of errs) console.error(`  - ${e}`);
  process.exit(2);
}
console.log(`${target} ✅ 通過（fast_path: ${cfg.fast_path ? 'ok' : '沒設 ⇒ 一律走 FULL'}）`);
