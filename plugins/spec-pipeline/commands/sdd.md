---
description: 分級規劃 → 規格 → Codex 審規格 → 實作 → Codex 審程式碼（含 F0 fast path）
argument-hint: '[--full] <任務描述>'
---

# /sdd — 規格驅動流程

審查一律用 **`codex-review` skill**（**不要**用 `openai-codex` plugin 的 `/codex:review`
—— 那個走 shared built-in reviewer，不是這裡要的做法）。

專案差異全部靠 **`.claude/pipeline.json`** 吸收；**缺它就 fail-closed**（見文末）。

---


## 選規劃模型

```
/sdd [--fable | --opus] [--full] <任務描述>
```

| 旗標 | 意思 |
|---|---|
| `--fable` | 這件事要用 **Fable** 規劃 |
| `--opus` | 這件事要用 **Opus** 規劃 |
| （不給） | 由 S0 判 `normal`/`hard` 並**給建議**，由你決定 |
| `--full` | 跳過 F0，直接走完整流程 |

⚠️ **我不能切換自己的模型。** 主對話的模型只有你能切（`/model`）。

⇒ 指定的模型與當前模型**不符時，我停下來請你切**，**不會**用錯的模型硬規劃。
這是刻意的：用錯模型規劃的成本，遠高於停下來問一句。

⇒ 研究（S1r）不受影響 —— 那本來就是派 Sonnet subagent，我設得動。

## Step 0 — F0：這件事需要走完整流程嗎？

⚠️ **不要自己用語意判斷。** 「純樣式／局部常數／單一 symbol／test-only」四個詞
都可以自我說服（`display:none` 藏功能、價格常數、共用 symbol、刪 assertion 都符合字面）。

先列出**明確的候選檔案路徑**，然後跑：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fast-eligibility.mjs" --check <path...>
```

| rc | 意思 | 做什麼 |
|---|---|---|
| **0** | FAST | 跳到 **Step 4**（單一 implementer，不拆平行 agent） |
| **10** | FULL | 往下走 Step 1 |
| 2 | 使用方式錯誤 | 補candidate 路徑再跑 |

使用者帶 `--full` ⇒ 直接走 FULL，不跑 F0。

⚠️ **owner 的明示切換有邊界**：可以強制走 full、可以改 `normal↔hard` 的模型選擇，
但**不能**讓沒通過 F0 機械條件的任務走 fast。

---

## Step 1 — S0 triage

只在**需求與驗收條件足以開始規劃**時判 `normal | hard`。

- 需求缺少 owner 才能決定的產品選擇 ⇒ 輸出 **`needs-clarification` 並停止**。
  **不得自己代替 owner 補需求。**
- **`hard`**：不可逆／外部狀態、資料或 API 相容性、安全／權限／金流，
  或同時改 ≥3 個獨立部署／ownership 邊界，或需在多個架構方案間作重大取捨
- **`normal`**：其餘
- 「已失敗兩輪」**不是**初始特徵 ⇒ 觸發 **retriage** 並升級 hard
- 單純玩家可見文字／樣式／局部數值**不因「玩家可見」自動變 hard**

S0 只給**建議**（`hard`→Fable、`normal`→Opus）。
- 你已經用 `--fable` / `--opus` 指定了 ⇒ **照你的**，S0 的建議只當參考記一筆
- 你沒指定 ⇒ 我講出建議並**問你要不要切**，不自己決定

## Step 2 — S1 規劃（＋ S1r 研究）

要查網路／查 repo 就派 **Sonnet subagent**，主對話只收結論。

## Step 3 — S2 規格 → S3 Codex 審規格

寫成文件（位置照專案慣例，例如 `plan/<主題>/design-<日期>.md`），然後用 `/codex-review` **模式 A**。

⚠️ **S3 不 GREEN 不進 Step 4。**

## Step 4 — S4 實作

- FAST：**單一 implementer**
- FULL：可拆平行 subagent

實作完**立刻**重驗 scope：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fast-eligibility.mjs" --verify-scope .claude/fast-baseline.json
```

`rc=10` ⇒ **停止 implementer、不自動回滾、保留 diff**，轉 full retriage 重走。

## Step 5 — 驗證 + S5 Codex 審程式碼

跑 `pipeline.json` 的 `verify_cmd`，**RC 寫檔再讀**。
然後 `/codex-review` 模式 A 審 code。

---

---

## 規劃者 = 監督者（whole-task ownership）

⚠️ **規劃的那個模型要負責到底，不是寫完規格就下班。**

S1 的規劃者**就是主對話**，也是唯一從頭到尾都在的角色。它持有六件事：

| # | 職責 | 失敗的樣子 |
|---|---|---|
| 1 | **凍結的規格是唯一驗收依據** | 實作偏離規格卻因為「測試過了」被放行 |
| 2 | S4 之後**逐條**比對規格 vs 實作 | 只看 verify RC=0 就宣告完成 |
| 3 | **不接受 subagent 的自我回報** | agent 說「已修好」就採信，沒要 `file:line` 與實跑證據 |
| 4 | 持有**輪數與停止條件** | 第三輪還在原地打轉卻繼續 review |
| 5 | **只有監督者能宣告 GREEN** | 某個 subagent 自己說 GREEN |
| 6 | 規格錯了 ⇒ **回 S2 改規格再走** | 就地改實作、規格從此與現實脫節 |

### 第 3 條要怎麼落實

派 subagent 時**在派工單裡就寫死**：
- 回報必須帶 `file:line`
- 宣告「修好了」必須附**負控組實跑紅**的證據（把實作改壞 → 測試真的紅 → 還原）
- **RC 一律寫檔再讀**，不要 `| tail`

收到回報之後，監督者**自己抽驗**至少一項，不要全盤採信。

### 第 6 條特別容易違反

任務中途發現規格有錯時，最省事的做法是**就地改實作**——但那會讓規格從此對不上現實，
下一輪 review 就會拿一份過期的規格來審。**回去改規格，再往下走。**

---
## 輪數與停止

> 每階段獨立計數：R1 初審、R2/R3 修正後複審。**R3 仍有 BLOCKER ⇒ 停下來問 owner。**
> 只有 `RC=0` 且回應完整才算一輪；CLI 失敗另走**最多兩次** invocation-retry。
>
> ⚠️ **跨 session 不支援 resume**（本流程不留持久狀態）。拿不到前輪完整 findings 時，
> **不得聲稱逐項收口** —— 當成新 run 從初審開始，或請 owner 貼上前輪內容。

## GREEN 的必要條件（同時成立）

`verify_cmd` RC=0 ＋ Codex RC=0 且回應完整 ＋ 該階段無未處理 BLOCKER。

## 缺 `.claude/pipeline.json` 時（fail-closed）

**只允許 Step 1–3 與唯讀檢查。** 不得進 Step 4、**不得修改任何專案檔案**，
也不得 commit / push / deploy / migration。
結果只能是 `BLOCKED_UNCONFIGURED` 或 `UNVERIFIED`，**不得 GREEN**。
