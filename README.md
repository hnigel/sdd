# claude-workflow

規格驅動流程的 Claude Code plugin：**分級規劃 → 規格 → 異廠商審規格 → 實作 → 異廠商審程式碼**。

```
/plugin marketplace add hnigel/claude-workflow
/plugin install spec-pipeline
```

## 提供什麼

| 東西 | 用途 |
|---|---|
| `/sdd` | 主流程。含 **F0 快路判定**、S0 分級、S3/S5 兩道 Codex 閘門、輪數與停止條件 |
| `codex-review` skill | 呼叫 Codex 的**單一來源**：模式選擇、環境釘死、RC 判讀、三條曾經寫錯的事實 |
| `scripts/fast-eligibility.mjs` | F0 的**機械**判定（不呼叫任何模型） |

## 每個專案要放 `.claude/pipeline.json`

```jsonc
{
  "verify_cmd": "npm run verify",        // 必填。缺它就 fail-closed
  "deploy_cmd": "npm run deploy",
  "commit_policy": "explicit-files",
  "fast_path": {
    "allow_globs": ["docs/**", "*.md"],
    "deny_globs":  ["**/migrations/**", "**/*secret*"]   // deny 優先於 allow
  }
}
```

**缺這個檔（或缺 `verify_cmd`）時 fail-closed**：只允許規劃與唯讀檢查，
**不得進實作、不得修改任何檔案**，結果只能是 `BLOCKED_UNCONFIGURED` / `UNVERIFIED`，
**不得 GREEN**。

⚠️ 這條的重點不是擋 deploy，是擋**「猜錯驗證命令 → 在未驗證狀態下宣告 GREEN」**——
那比 deploy 錯更糟，因為它製造假信心。

## 三條設計原則（都是被 review 打回來才學到的）

**① 「deterministic」寫在 Markdown 裡就不是 deterministic。**
「純樣式／局部常數／單一 symbol／test-only」四個詞**都可以自我說服**。
反例：`display:none` 可以藏掉整個功能、價格常數改一個數字就是經濟改動、
共用 symbol 改一處影響全 repo、刪掉 assertion 就是把守衛拔掉。
⇒ F0 是**腳本**，靠 `allow_globs`/`deny_globs` 與機械 diff 規則判定，**任何未知一律走完整流程**。

**② 想要自訂 review 格式，就不能用 `codex exec review` 子命令。**
`--commit` / `--uncommitted` / `--base` **都與 PROMPT 互斥**（實測 `rc=2`）。
⇒ S3/S5 一律用 plain `codex exec ... - < prompt.txt`，在 prompt 裡自己寫死 target 與基準 SHA。

**③ 不留持久狀態 ⇒ 跨 session 不支援 resume。**
拿不到前一輪完整 findings 時，**不得聲稱逐項收口**。

## 刻意不做

- ❌ **log / 遙測 / retro** —— 一個人用的量在統計上到不了任何決策點
  （每週 1–4 件 eligible task，光是 20 pilot + 80 confirmatory 就要 25–100 週）
- ❌ **審查 ROI 實驗** —— 同上。審查固定開，理由是品質，不宣稱省成本
- ❌ `openai-codex` plugin 的 `/codex:review`（走 shared built-in reviewer）
