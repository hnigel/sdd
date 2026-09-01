# 查過的帳 —— 開工前先讀這裡

> **這份文件的用途只有一個：讓「已經查過的問題」不必再查一次。**
>
> 要改這個 plugin、或又遇到「審不完」「假綠」「跨機漂移」之類的問題時，
> 先在這裡找。找得到就別重查；找不到再開新的調查，**查完回來寫進這裡**。
>
> ⚠️ **每條事實都附重驗指令，而且都會過期。** 這個 repo 已經被
> 「帶版本號的實測筆記過期而且沒有訊號」咬過一次（見 §1 的 F-過期 條）。
> 引用任何一條之前，先跑它的重驗指令。跑出來不一樣就**改事實、不要改結論結構**。

---

## 0. 索引：常見問題 → 去哪裡找

| 你想問的 | 答案在 |
|---|---|
| 為什麼 review 永遠審不完？ | §2（診斷）＋ `design-green-semantics-2026-09-01.md` §3b（前案） |
| 讓模型判斷「收斂了沒」可行嗎？ | §3 死路 D1（不可行，有實測）＋ §4（可行的變形） |
| green_allowed 為什麼是自我回報？要怎麼修？ | `design-green-semantics-2026-09-01.md`（整份） |
| Codex 的 log 為什麼那麼大？要不要優化？ | §5 量測 M1（多半不用） |
| 改了 plugin 為什麼使用者拿不到？ | §1 F-版本號 |
| Mac 上為什麼壞掉？ | §1 F-zsh |
| 這些設計試過嗎？ | §3 死路清單 |

---

## 1. 已查證的機器事實（2026-09-01 全部重驗過）

| 事實 | 重驗指令 |
|---|---|
| **F-codex 版本**：本機 `codex-cli 0.144.1`。契約文件曾宣稱事實驗於 v0.150.0-alpha.7，**本機從未出現過那個版本**——那想必是另一台機器讀到的，而筆記沒說是哪台 | `codex --version` |
| **F-config 漂移**：`~/.codex/config.toml` 實際是 `gpt-5.5` / `medium`，與契約釘死值不同。**同一台機器一天之內漂過一次**。⇒ 呼叫點必寫 `-m`/`-c`，不要繼承環境 | `cat ~/.codex/config.toml` |
| **F-banner 走 stderr**：`codex exec` 的 model/effort banner 在 **stderr**，stdout 只有答案。想在腳本裡驗釘值就不能用 `execFileSync`（只回 stdout），要 `spawnSync` 取雙串流 | `echo ok \| codex -C "$PWD" -s read-only -a never exec -m gpt-5.6-sol - >/dev/null` 看 stderr |
| **F-prompt 回顯**：codex 會把送進去的 prompt 回顯進 log（0.144.1 實測，log 第 13 行）。**任何建在這個行為上的機制都是未版本化相依** | `grep -n '<你 prompt 的第一句>' <out.log>` |
| **F-^codex$ 不可靠**：一份正常結束的 2,999 行 log 裡出現 **5 次**，另一份中途結束的只出現 1 次且在推理開頭。⇒ 別用 awk 定位結論，判定交給哨兵區塊 | `grep -c '^codex$' <out.log>` |
| **F-版本號**：`claude plugin update` **比版本號，不比 commit**。改了 `plugins/` 卻不 bump，使用者會拿到 `already at the latest version`——**語氣是成功的，所以沒人會去查**，而 cache 停在舊 commit | `claude plugin list` 看版本；doctor 看 `plugin_pin` 的 sha |
| **F-兩個 scope**：`installed_plugins.json` 的結構是 `{version, plugins: {"名稱@marketplace": [...]}}`（**巢狀一層**），同一個 plugin 可能同時有 user 與 project scope，`update` 的 `--scope` **預設只更新 user** | `node .../doctor.mjs` 看 `plugin_pin` |
| **F-zsh**：`RS="node x.mjs"; $RS --flag` 依賴 shell 對未加引號展開做分詞。**bash 會，zsh 預設不會**，而 macOS 預設 shell 是 zsh。⇒ 一律用 shell function | `zsh -c 'RS="node --version"; $RS'`（本機無 zsh，未實測，見 §6） |
| **F-過期**：以上每一條都曾經、或可能再度過期。**帶版本號或機器狀態的「實測事實」必須同段附重驗指令**——這是設計原則④ | — |

---

## 2. 診斷：為什麼「審不完」

**核心：審查者兼任了編輯。** findings 直接等於放行判準（零 BLOCKER 才放行），
而那是一個**從未被觀察到出現過的狀態**（實測五輪：7→4→5、7→2，零從未出現）。

⚠️ **但真正的成因比「審不完」更精確**（2026-09-01 由一個扮演編輯的 Opus agent 指出，
並經軌跡資料驗證）：

> **審查者對看過的東西是嚴格收斂的**——宣告收口後從不回頭。
> 撐住 findings 數的**只有每輪修訂新增的材料**。
> ⇒ **發散的不是審查迴圈，是寫規格的迴圈。**

證據（run1 三輪）：

| 輪 | 行數 | findings | 打原始工件 | 打「為回應上一輪而新發明的機制」 |
|---|---|---|---|---|
| R1 | 242 | 7 | 7/7 | 0 |
| R2 | 279 | 4 | **0** | **4/4** |
| R3 | 318 | 5 | 0 | **5/5** |

行數每輪穩定 +38，findings 穩定 4–5 條，**兩個速率都沒下降 ⇒ 不是收斂，是穩態**。

**可操作的判準**：**一次修訂讓規格變長、而 findings 沒下降 ⇒ 該拆該減，不是該再審一輪。**

---

## 3. 死路：試過且失敗的設計（**勿復活原形**）

完整死因見 `design-green-semantics-2026-09-01.md` §2、§3。摘要：

| # | 設計 | 死因 |
|---|---|---|
| D1 | **讓 LLM 判斷自己產出的意見重不重要** | Greptile 公開實測：**「the LLMs judgment of its own output was nearly random」**，且「壓低瑣碎意見時關鍵意見會一起變少」。他們的解法是 embedding+KNN 比對歷史人工反饋——統計的，不是再一次 LLM 推理。我們建不起那個資料集 |
| D2 | `green_allowed = 最後一輪 VERDICT SHIP` | D1 的實例。**已標記否定，勿照做** |
| D3 | 時間 proxy（`at > 最後修訂時間`） | 無關清空輪可誤銷 |
| D4 | `--revision <n>` 整數綁定 | 漏貼 delta 後傳最新號即可過關，**不需要主動偽造** |
| D5 | `<<<CARRIED-OVER:sha16>>>` marker | 建在「codex 會回顯 prompt」這個未版本化行為上 |
| D6 | `--arm --watch`（C9） | 端點比對擋不住 X→Y→X；且**它不回應任何 finding，是自發增生物**，卻吃掉 R3 40% 的 findings |
| D7 | pending/promote 狀態機 | **審查者自己提出、被採納、下一輪自己撤回**（原話：「我撤回 R1-B4 的設計」）。兩方各試一次而失敗 |
| D8 | log 檔 mtime 當守衛 | 可被 touch／複製刷新，無 provenance |
| D9 | 同專案並行 run 的隔離（三案） | **不是技術失敗，是 owner 裁定不做。** 評估過：<br>**A** 可覆寫狀態檔路徑（約 5 行，但**要人記得傳**——又是人工紀律）<br>**B** per-run 命名空間（最正確，但每個指令多一個必填參數 = 新表面）<br>**C** `Agent(isolation:"worktree")`（零 plugin 改動，但審查目標在副本裡、合併要人工，而並行任務其實是在**同一份 codebase** 上）<br>⇒ **維持現狀。一個 session 一件事，鎖負責在誤觸時 fail-closed。**<br>⚠️ **派 agent 不能解決這件事** —— agent 沒有自己的檔案系統，照樣寫同一個狀態檔 |

⚠️ **D3–D8 有一個共同形狀**：都是「為了修補上一輪而發明的機制」，而每一個都在下一輪
被打。**這個模式本身就是訊號**——見 §2。

---

## 4. 可行的做法（已實作或已驗證）

| 機制 | 狀態 | 外部前案 |
|---|---|---|
| **BLOCKER 必帶 `[FAIL] <輸入> -> <錯誤結果>`**，缺欄位 rc=2 | 已實作 | Claude Code REVIEW.md 的 Verification bar |
| **R2 起降 effort 到 medium、只報 BLOCKER、不提新 POLISH** | 已寫進契約 | 同上的 re-review convergence：原文說可以 "stop a one-line fix from reaching round seven on style alone" |
| **POLISH 上限 5 條，其餘給數量** | 已寫進契約 | 同上 Nit volume：「Prose and config files can be polished forever」 |
| **軌跡 `new_citations`**：這輪指了幾個先前沒指過的位置 | 已實作 | —（自製，純字串處理不判語意） |
| **停點問編輯的問題**（哪幾條夠格擋關），不問「還要不要繼續」 | 已實作 | PLOS／ICMJE 的審稿人—編輯分離 |
| **派 agent 當編輯做裁決** | **回測過，可用**，但**只能當簡報不能當閘門** | 見 `design-green-semantics` §6c |
| **要求編輯給可否證條件** | 回測中最有價值的產物：它列的三條重現測試，當場作廢掉三分之二的 BLOCKING | — |

⚠️ **閘門一律留在腳本，不交給任何模型。** Anthropic 自家的 code review 產品
明確讓生成式模型不做裁決（findings「don't approve or block your PR」、
check run「always completes with a neutral conclusion」）。**最有動機讓 AI 審查具
權威性的一方拒絕了這件事**，這比任何論證都強。

---

## 5. 量測過的東西（別再重算）

**M1 — Codex log 的組成（2026-09-01，三份真實 log）**

一份 2,178 行的 review log：**1,973 行（90.6%）是 `nl -ba` 傾印的檔案內容**，
43 行空白，**真正的推理與結論只有 162 行**。

⚠️ **成本模型的修正**：那些傾印是 shell stdout 被注入 context，**是輸入不是輸出**。
模型生成的是約 65 個指令 + 162 行推理。所以：

- ❌ 不是 output token 浪費
- ✅ 是 input token 與 **context 佔用**
- 讀檔很快 ⇒ **log 行數與耗時沒有穩定關係**

**結論：別把 log 行數當任何東西的代理量。** 唯一無副作用的降低手段是**縮小 review
target**（同 §2 的判準）。**不要**叫它少讀、餵它預擷取的片段、或告訴它前輪驗過什麼
——那三個都是拿驗證品質換行數，而讀檔正是我們要求它做的事。

重驗：`grep -cE '^ *[0-9]+\t' <out.log>` 對 `wc -l <out.log>`

**M3 — `finally` 擋不住 `process.exit()`**（2026-09-01 實作鎖時當場踩到）

這些腳本到處用 `process.exit` 表達 rc（`usage()` 是 2、STOP_ASK_OWNER 是 20…）。
把釋放寫在 `finally` 裡**不會執行** ⇒ 鎖漏在磁碟上 ⇒ 下一個指令被自己卡住。
⇒ 必須同時掛 `process.on('exit', release)`。已有回歸測試守著。

**M2 — 跨輪重複讀取**：每輪碰 7–17 個相異檔案，三輪各讀一遍同一批。
**這是真實的重複，但不建議修**——要它採信我們「前輪驗過了」的轉述，
等於拿掉它作為獨立審查者的價值。

---

## 6. 仍然開著的（不是忘了，是刻意）

| 缺口 | 為什麼還開著 |
|---|---|
| `green_allowed` 仍是自我回報 | 修法方向已定但未實作，見 `design-green-semantics` |
| **同一專案、同一 stage 只能有一個 run** | 狀態檔按 stage 分不按任務分。鎖只防**寫壞**（並行寫互相覆蓋），不解決**兩件事共用一個 S3 槽**的邏輯衝突。⇒ **owner 2026-09-01 裁定：不做隔離，維持「一個 session 處理一件事」。** 評估過三個做法都不採用，見 §3 D9 |
| `--revise` 之後沒有強制複審（G1） | 兩方各試一次而失敗（D7）。誠實記載勝過一道擋不住的閘 |
| force restart 不強制帶入已知 BLOCKER（G2） | 同上 |
| 審查期間 target 被改動無機械偵測（G3） | 同上（D6） |
| **zsh 行為未在本機實測** | 這台是 WSL，沒有 zsh。依據是 zsh 文件化語意 + 一次真實 macOS run 的筆記。**Mac 端驗收壓在 owner 身上** |
| Mac 完整 S0→S5 流程未驗收 | 同上 |

---

## 7. 寫進這份文件的規矩

1. **每條事實附重驗指令。** 沒有重驗指令的事實會過期而且沒有訊號。
2. **死路要寫死因，不只寫「不行」。** 下一個人才不會用同一個形狀再試一次。
3. **外部前案要附 URL，並標明是否逐字覆核過。**
4. **量測要附方法**，否則下次得重算。
5. **查完新東西回來寫這裡**，不要只寫在 commit message 裡——commit message 沒有人會回頭翻。
