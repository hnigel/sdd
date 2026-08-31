---
name: spec-pipeline
description: 分級規劃 → 規格 → Codex 審規格 → 實作 → Codex 審程式碼。流程主體，由 /fable、/opus 帶入指定的規劃模型
---


# 規格驅動流程（spec-pipeline）

審查一律用 **`codex-review` skill**（**不要**用 `openai-codex` plugin 的 `/codex:review`
—— 那個走 shared built-in reviewer）。

專案差異全部靠 **`.claude/pipeline.json`** 吸收；**缺它就 fail-closed**（見文末）。

---


## 指定的規劃模型

呼叫端（`/fable` / `/opus`）會告訴你**這件事該用哪個模型規劃**。
**兩個入口都在斷言模型 —— 沒有「不指定」這條路。**

⚠️ **我不能切換自己的模型。** 主對話的模型只有 owner 能切（`/model`）。

| 情況 | 做什麼 |
|---|---|
| 指定的模型 **== 當前模型** | 直接往下走 |
| 指定的模型 **≠ 當前模型** | **停下來請 owner 切**（`/model`）。不得用錯的模型硬規劃 |
| 指定的模型 **與 S0 判定不一致** | **講一聲，然後照指定的做**（見 Step 1）。這是唯一的難度訊號，不得省略 |

⇒ 研究（S1r）不受影響 —— 那本來就是派 Sonnet subagent，設得動。

## Step 0 — F0：這件事需要走完整流程嗎？

⚠️ **不要自己用語意判斷。** 「純樣式／局部常數／單一 symbol／test-only」四個詞
都可以自我說服（`display:none` 藏功能、價格常數、共用 symbol、刪 assertion 都符合字面）。

### 先問一句：現在知道要改哪些檔嗎？

| 情況 | 做什麼 |
|---|---|
| **不知道**（調查型：「查一下」「為什麼會…」「玩家回報…」） | **直接走 FULL，不跑 F0** |
| 知道 | 列出明確路徑，跑 F0 |

⚠️ **scope 未知 = 風險未知 ⇒ 一定 FULL。** F0 刻意不接受「你自己去找要改哪些檔」——
那等於把機械判定變回語意判斷。所以調查型任務**沒有路徑可給**，這不是錯誤，
是「它本來就該走完整流程」。（`rc=2` 是**用法或設定錯誤**，不要拿它當「再試一次」的訊號。）

### 知道路徑時

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fast-eligibility.mjs" --check <path...>
```

| rc | 意思 | 做什麼 |
|---|---|---|
| **0** | FAST | 跳到 **Step 4**（單一 implementer，不拆平行 agent） |
| **10** | FULL | 往下走 Step 1 |
| **2** | 用法**或設定**錯誤 | **先讀 stderr**。設定寫錯（例如 `fast_path` 有未知鍵）⇒ 回報 owner 去修，**不要繞過**；沒給路徑 ⇒ 回上表當調查型走 FULL。兩種都**不要**猜路徑重試 |

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

S0 只給**建議**（`hard`→Fable、`normal`→Opus）。你打 `/fable` 或 `/opus` 就是已經指定，
**照你的做，不要擅自改。**

⚠️ **但指定與建議不一致時一定要講一聲**（例如你打 `/opus`、S0 判 `hard`）——
那個不一致本身就是訊號，可能代表這件事比你以為的複雜。
既然沒有「不指定」的入口，**這句提醒就是整個流程唯一的難度訊號**，不得省略。

⚠️ retriage 升級成 `hard` 時（上面「已失敗兩輪」那條），若當前是 Opus ⇒
**停下來請 owner 切 Fable 再重跑規劃**，不要用 Opus 硬接一個已經判 hard 的任務。

## Step 2 — S1 規劃（＋ S1r 研究）

要查網路／查 repo 就派 **Sonnet subagent**，主對話只收結論。

## Step 3 — S2 規格 → S3 Codex 審規格

寫成文件（位置照專案慣例，例如 `plan/<主題>/design-<日期>.md`），
然後**載入 `codex-review` skill**、走**模式 A**。
（它是 skill 不是斜線指令 —— 沒有 `/codex-review` 這個東西。）

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
然後**載入 `codex-review` skill**、走模式 A 審 code。

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
