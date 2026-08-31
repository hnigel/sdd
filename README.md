# sdd — spec-driven pipeline

規格驅動流程的 Claude Code plugin：**分級規劃 → 規格 → 異廠商審規格 → 實作 → 異廠商審程式碼**。

```
/plugin marketplace add hnigel/sdd
/plugin install spec-pipeline
```

## 提供什麼

| 東西 | 用途 |
|---|---|
| `/fable` `/opus` | 兩個薄指令，只帶入「這件事該用哪個模型規劃」 |
| `spec-pipeline` skill | **流程主體**（唯一來源）：F0 快路、S0 分級、S3/S5 兩道 Codex 閘門、輪數與停止條件 |
| `codex-review` skill | 呼叫 Codex 的**單一來源**：模式選擇、環境釘死、RC 判讀、三條曾經寫錯的事實 |
| `scripts/fast-eligibility.mjs` | F0 的**機械**判定（不呼叫任何模型） |
| `scripts/review-state.mjs` | **輪數與收口狀態**。跨 session 可接續，R3 停止條件由它執行 |
| `scripts/spec-freeze.mjs` | **凍結規格 + delta 複審**。偵測「把規格改成符合實作」 |
| `schemas/pipeline.schema.json` | 設定形狀的**單一來源**：腳本與 CI 讀同一份 |

## 每個專案要放 `.claude/pipeline.json`

```jsonc
{
  "verify_cmd": "npm run verify",        // 必填。缺它就 fail-closed
  "fast_path": {
    "allow_globs": ["docs/**", "*.md"],
    "deny_globs":  ["**/migrations/**", "**/*secret*"],  // deny 優先於 allow
    "_comment": "`_` 開頭的鍵是註解，可以自由加"
  }
}
```

⚠️ **`fast_path` 裡出現未知鍵一律 `rc=2`（設定錯誤），不會默默降級。**
理由：`allow_globs` 拼錯會 FULL（安全方向），`deny_globs` 拼錯卻會讓整條 deny
靜默失效、敏感路徑拿到 FAST —— 方向剛好相反。這是唯一一個 fail-open 的洞，所以堵死。
（想寫註解就用 `_` 開頭，那些鍵會被略過。）

其他鍵（`deploy_cmd`、`commit_policy` 之類）不會被這個 plugin 讀，放著無妨。

**缺這個檔（或缺 `verify_cmd`）時 fail-closed**：只允許規劃與唯讀檢查，
**不得進實作、不得修改任何檔案**，結果只能是 `BLOCKED_UNCONFIGURED` / `UNVERIFIED`，
**不得 GREEN**。

⚠️ 這條的重點不是擋 deploy，是擋**「猜錯驗證命令 → 在未驗證狀態下宣告 GREEN」**——
那比 deploy 錯更糟，因為它製造假信心。

## 四件事都機械化了（模型講不過去的東西才算數）

| 該擋的 | 誰擋 | 講不過去的形式 |
|---|---|---|
| 這件事要不要走完整流程 | `fast-eligibility.mjs` | glob + git diff + exit code |
| 現在第幾輪、能不能宣告 GREEN | `review-state.mjs` | 狀態檔 + `rc=20/21` |
| 規格有沒有被偷偷改成符合實作 | `spec-freeze.mjs` | sha256 比對 + `rc=20` |
| 設定與 plugin 形狀有沒有漂移 | `schemas/` + `scripts/validate-plugin.mjs` | CI |

⇒ 這四個都曾經是散文。散文寫得再清楚，實際做判斷的還是模型。

## 三條設計原則（都是被 review 打回來才學到的）

**① 「deterministic」寫在 Markdown 裡就不是 deterministic。**
「純樣式／局部常數／單一 symbol／test-only」四個詞**都可以自我說服**。
反例：`display:none` 可以藏掉整個功能、價格常數改一個數字就是經濟改動、
共用 symbol 改一處影響全 repo、刪掉 assertion 就是把守衛拔掉。
⇒ F0 是**腳本**，靠 `allow_globs`/`deny_globs` 與機械 diff 規則判定，**任何未知一律走完整流程**。

**② 想要自訂 review 格式，就不能用 `codex exec review` 子命令。**
`--commit` / `--uncommitted` / `--base` **都與 PROMPT 互斥**（實測 `rc=2`）。
⇒ S3/S5 一律用 plain `codex exec ... - < prompt.txt`，在 prompt 裡自己寫死 target 與基準 SHA。

**③ 用免責聲明取代功能，是在騙自己。**
原本 skill 寫「跨 session 不支援 resume ⇒ 不得聲稱逐項收口」——
但「逐項核對上一輪」正是實測讓 R1→R5 變成一輪見底的手法，
等於把最有效的手法建在一個會斷的地基上。
⇒ `review-state.mjs` 把那一 run 的操作狀態存下來，換 session 接得回去。
（這**不是**下面否決的那個 log —— 被否決的是遙測與統計彙總，不是操作狀態。）

## 開發

零依賴，不需要 `npm install`：

```bash
node --test plugins/spec-pipeline/tests/*.test.mjs   # 44 個 case
node scripts/validate-plugin.mjs                     # manifest / frontmatter / 引用 / schema
```

CI 兩件都跑。改腳本一定要跑，並且**附負控組**（改壞 → 測試真的紅 → 還原）。

## 刻意不做

- ❌ **log / 遙測 / retro** —— 一個人用的量在統計上到不了任何決策點
  （每週 1–4 件 eligible task，光是 20 pilot + 80 confirmatory 就要 25–100 週）
- ❌ **審查 ROI 實驗** —— 同上。審查固定開，理由是品質，不宣稱省成本
- ❌ `openai-codex` plugin 的 `/codex:review`（走 shared built-in reviewer）
