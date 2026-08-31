/**
 * 極小的 JSON Schema 子集驗證器 —— **唯一來源是 schemas/pipeline.schema.json**。
 *
 * ## 為什麼自己寫而不是用 ajv
 * 這是 Claude Code plugin，使用者不會跑 `npm install`。任何 runtime 依賴都等於「在別人機器上不會動」。
 *
 * ## 為什麼不直接把規則寫死在 fast-eligibility 裡
 * 那樣 schema 檔跟實際檢查會是兩份，遲早漂移 —— 而這個 repo 的漂移已經咬過四次。
 * ⇒ schema 是唯一來源，fast-eligibility 與 CI 都讀它。
 *
 * 支援的關鍵字（夠這份 schema 用，多的不裝懂）：
 *   type / required / properties / additionalProperties / items / minItems / minLength
 * ⚠️ `_` 開頭的鍵一律視為註解，不受 additionalProperties 管。
 */
const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

export function validate(value, schema, where = '') {
  const errs = [];
  const at = (k) => (where ? `${where}.${k}` : k);

  if (schema.type && typeOf(value) !== schema.type) {
    errs.push(`${where || '(根)'} 應該是 ${schema.type}，實際是 ${typeOf(value)}`);
    return errs;   // 型別就錯了，再往下查只會噴一堆雜訊
  }
  if (schema.type === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errs.push(`${where} 不可以是空字串`);
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errs.push(`${where} 至少要有 ${schema.minItems} 個項目`);
    }
    if (schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items, `${where}[${i}]`)));
  }
  if (schema.type === 'object' || schema.properties) {
    for (const k of schema.required ?? []) {
      if (!(k in value)) errs.push(`缺 ${at(k)}`);
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const k of Object.keys(value)) {
        if (k.startsWith('_')) continue;   // 註解鍵
        if (!known.has(k)) {
          errs.push(`${at(k)} 是未知鍵（認得的只有 ${[...known].join(' / ')}；註解請用 \`_\` 開頭）`);
        }
      }
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in value) errs.push(...validate(value[k], sub, at(k)));
    }
  }
  return errs;
}
