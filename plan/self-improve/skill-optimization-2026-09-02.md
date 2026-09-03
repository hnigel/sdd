# skill 優化建議 —— 編輯角色的高度檢視（2026-09-02）

- 讀者：owner。問題只有一個：**這套 skill 接下來該怎麼優化？**
- 角色：編輯，不是第四個審查者。逐條審查的東西這裡不重審；這裡問的是逐條審查問不出來的問題（design-green-semantics §6b 的五題）。
- 依據：README、LEDGER、design-green-semantics、design-2026-09-01（v7）、HANDOFF、兩份 SKILL.md、四支腳本、`ref/`。**每條建議都指到已驗證的問題**——LEDGER／設計文件的段落，或我自己在程式碼裡查到的 `檔案:行號`（§1 列出，附重驗指令）。
- 利益衝突聲明：我是 Anthropic 的模型，而這個 repo 最強的論證之一是「Anthropic 自家 code review 產品拒絕讓生成式模型當閘門」。我可能高估那條論證的重量；§7 有記。

---

## 0. 結論摘要（15 行內）

1. **這台 Mac 裝的是 0.1.0（project scope，commit `e7f60e0`），repo 是 0.6.0（`fddae17`）。** 過去十五個 commit 的全部硬化——輪數守衛、鎖、`--force`、`[FAIL]` 欄位、`--prompt-block`、`divergence_hint`、effort 分級——**在這台機器上一個都沒有**。先更新，再談優化。
2. **v7 出貨規格有三項沒落地**：C1-6（`green_allowed` 弱訊號提示行）、C5-⑥（README 邊界條款）、C7（log sha）。其中 C1-6 是設計文件 §0 明寫的**唯一**過渡措施。三項「六輪無一被實質反對」、凍結、然後沒有實作——而且 LEDGER 沒有記載放棄。**這套流程的監督者職責第 2 條（逐條比對規格 vs 實作），在它自己身上沒有執行。**
3. **設計文件 §0 的操作規則（「收口靠 `--resolve` 的 `green_allowed` 一律再送一輪複審」）不在任何一份 SKILL 裡。** 照 SKILL 字面走：R1 → 全部 `--resolve` → `green_allowed:true` → 凍結 → 實作，零複審。腳本（`spec-freeze.mjs:89-108`）放行這條路。
4. 排第一的建議是**減法與補帳**，不是新機制：更新 Mac、補齊或明記放棄 v7 三項、把操作規則寫進 SKILL、刪掉模式 B 與重複事實、然後**在下游專案真跑 3–5 次**只記三個數字。這五件事全部零新表面。
5. **最大風險**：這套流程的保證被「寫下來」的速度快過被「跑起來」的速度。所有校準資料都來自審「審查流程自己的規格」（§6c 已指出這是自指）；F0 在真實執行裡從未被呼叫過；S5 從未以模式 A 真跑過；Mac 端一輪都沒跑過。
6. **該刪的**：codex-review SKILL 的模式 B（流程裡走不通的路，產出必然 `rc=21`）；SKILL 裡與 LEDGER 重複的五條機器事實；兩套互相矛盾的 effort 表其中一套；`--blockers <n>`（有條件，排在實跑之後）。
7. **不該做的**：任何 green 語意重設計、任何 harness hook、`ref/` 候選池的九條（其中五條與 LEDGER 已驗證診斷直接衝突或是死路原形）。理由逐條在 §3。
8. `ref/` 85 個專案裡**沒有一個讓 sdd 的某部分變成不必要**。但本機 `openai-codex` plugin 1.0.4 的 Stop hook 是 sdd 的鏡像：**強制力有、裁決交給模型**（`stop-review-gate-hook.mjs:83`）。sdd 是反過來。最不舒服的一句：S5 這一半的存在理由是「異廠商」，而這個前提**沒有被量過**。

---

## 1. 我自己查到、LEDGER 與設計文件沒記的事實

每條附重驗指令（依 LEDGER §7 規矩）。全部在 repo HEAD `fddae17` 上查。

| # | 事實 | 重驗 |
|---|---|---|
| **N1** | **v7 三項未落地**。C1-6：`review-state.mjs:495-513` 的 `status()` 沒有「已全部標記處理但未經複審輪」的分支；C5-⑥：README 沒有「閘門約束的是進入流程的任務」段；C7：`record()`（`:364-370`）只存 `log: logFile`（揮發的 mktemp 路徑），沒有 `log_sha256`/`log_bytes`。C6 有做（零命中）。 | `grep -n '弱訊號\|log_sha256' plugins/spec-pipeline/scripts/review-state.mjs; grep -n '進入流程的任務' README.md` → 三者皆無命中 |
| **N2** | **操作規則不在 SKILL**。design-2026-09-01 §0：「看到 `green_allowed: true` 且收口靠 `--resolve`，一律再送一輪複審」。兩份 SKILL 唯一含「再送一輪」的句子是反向的（`spec-pipeline/SKILL.md:232`，講 `divergence_hint` 時「不要再送一輪」）。`spec-pipeline/SKILL.md:130`「GREEN 的判定看 `--status S3` 的 `green_allowed`」→ `:132` 凍結。`spec-freeze.mjs:102-107` 的 `assertS3Clear()` 只看最後一輪是否全部 `resolved`。 | `grep -rn '再送一輪\|複審輪' plugins/spec-pipeline/skills/` |
| **N3** | **Mac 端裝的是 0.1.0**（project scope，`e7f60e0`），只有這一個 entry；repo 是 0.6.0（`fddae17`）。本 repo 的 `.claude/` 只有 `pipeline.json`，**沒有任何狀態檔** ⇒ 這台從未跑過任何 stage。 | `node ~/.claude/plugins/cache/sdd/spec-pipeline/*/scripts/doctor.mjs` 看 `plugin_pin`（注意 0.1.0 沒有 doctor.mjs，要用 repo 裡的）；`ls .claude/` |
| **N4** | **codex-review SKILL 內兩套 effort 表互相矛盾**。`:47`、`:114` 寫 R1 = `xhigh`；`:69-72` 寫依 target 行數（<50 行 → `low`）。`doctor.mjs:30-32` 的 `PINNED_EFFORT='xhigh'` 註解寫「契約釘死的值」，但契約已不釘。`review-state.mjs:488-491` stderr 說「比上一輪降一級」——若 R1 是 `low`，「降一級」無定義。 | `grep -n 'xhigh' plugins/spec-pipeline/skills/codex-review/SKILL.md plugins/spec-pipeline/scripts/doctor.mjs` |
| **N5** | **五條機器事實同時在 LEDGER 與 codex-review SKILL**：banner 走 stderr、zsh 分詞、config.toml 漂移、`0.144.1`、`nl -ba`/90.6%。這正是 F-過期 的形狀，乘二。兩份 SKILL 合計 634 行、42 個「⚠️」。 | `for k in stderr zsh config.toml 0.144.1 'nl -ba' 90.6; do grep -c -- "$k" plan/self-improve/LEDGER.md plugins/spec-pipeline/skills/codex-review/SKILL.md; done` |
| **N6** | **模式 B 是流程裡走不通的路**。`codex exec review` 子命令的輸出沒有哨兵區塊 ⇒ `--record` 必回 `rc=21`（`review-state.mjs:348-357`）。而 `spec-pipeline/SKILL.md:113`（S3）與 `:165`（S5）都指定模式 A。模式 B 只存在於 codex-review SKILL 的表格與 Step 2 範例。 | `grep -n '模式 B' plugins/spec-pipeline/skills/*/SKILL.md` |
| **N7** | **`--blockers <n>` 產生的輪沒有內容可核對**。`review-state.mjs:339-345` 每條 text 是 `(由呼叫端宣告，無內容)` ⇒ 下一輪 `--prompt-block` 帶出去的項目是空的，「逐項核對上一輪」（LEDGER §4 記為讓 R1→R5 變一輪見底的手法）從那一輪起做不到。LEDGER F11：真實 run 曾「本次全程都這樣用」。 | `sed -n 336,345p plugins/spec-pipeline/scripts/review-state.mjs` |
| **N8** | **plugin 沒有 hooks**。所有閘門都是「模型選擇去跑的腳本」。v7 §5 明記不做 hook（理由：無法辨識任務歸屬）；但揭露這件事的 README 條款（C5-⑥）沒出貨（N1）。 | `ls plugins/spec-pipeline/hooks` → 不存在 |
| **N9** | **本機 `openai-codex` 1.0.4 有 Stop hook**（`hooks/hooks.json`）→ `stop-review-gate-hook.mjs` 把上一則 assistant 訊息送 Codex，**回覆首行 `BLOCK:` 就 `decision: block`**（`:83-84`、`:168-169`）。強制力在 harness，裁決在模型——D1 的形狀。 | `cat ~/.claude/plugins/cache/openai-codex/codex/1.0.4/hooks/hooks.json; grep -n 'BLOCK:' ~/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/stop-review-gate-hook.mjs` |

---

## 2. 排序過的建議

每條：解決哪個已驗證問題 ／ 形狀（加或減；加的話會不會變新表面）／ 腳本能執行還是只能寫進 prompt ／ 可否證條件 ／ 對照死路。

### R1 — 建議做：先把 Mac 更新到 0.6.0，跑 doctor，然後才動任何一個字

- **解決**：N3。這不是優化建議，是優化的前提。任何關於 SKILL 文字的討論，對一台跑 0.1.0 的機器都是空談；LEDGER §6「Mac 完整 S0→S5 未驗收」其實低估了——Mac 連版本都沒拿到。
- **形狀**：減。零新東西。
- **腳本／prompt**：純操作。`claude plugin update spec-pipeline@sdd --scope project`（在裝了 project scope 的那個專案目錄下），重開 session，跑 `doctor.mjs --probe-codex`。
- **可否證條件**：更新後 `installed_plugins.json` 該 entry 的 `gitCommitSha` 前 12 碼等於 `git rev-parse HEAD` 的前 12 碼，且 `installPath` 含 `/0.6.0/`。若已經是，此條作廢——我查的時候不是。
- **對照死路**：不是機制，無對照。
- **附帶**：F-兩個 scope 在這台機器上是現實：只有 project scope entry。README §1b 的警告句寫對了，但 owner 自己這台就是那個案例。值得在 LEDGER §1 F-兩個 scope 補一行「2026-09-02 Mac 實例：只有 project scope、停在 0.1.0」。

### R2 — 建議做：補齊 v7 三項未落地（C1-6 優先），或在 LEDGER 明記放棄

- **解決**：N1；F1（`green_allowed` 自我回報）——C1-6 是設計文件 §0 對 F1 的唯一過渡措施。
- **形狀**：三項都是 v7 已裁定的形狀，不是新設計：
  - C1-6：`status()` 多印一行。**不改 `green_allowed` 的值、不改 exit code、不寫狀態檔。** 零新 trusted proposition。
  - C5-⑥：README 一段話。誠實記載型（LEDGER 思考紀律第 6 條）。
  - C7：round 加 `log_sha256`、`log_bytes`。純 metadata，不當閘門用（G4 的 mtime 版死過，這條**不宣稱**解 G4，只是讓「哪份 log」可事後對照）。
- **腳本／prompt**：C1-6、C7 腳本；C5-⑥ 文件。
- **可否證條件**（hermetic fixture，`node --test`）：
  - C1-6：R1 記 2 條 BLOCKER → `--resolve` 兩條 → `--status` 輸出含「未經複審」且 `green_allowed` 與現行為相同（true）；負控：R1 零 BLOCKER → `--status` 不含該句。改壞（把分支拿掉）→ 紅 → 還原。
  - C7：`log_sha256` 與 Node `crypto` 對同一檔實算一致；非 ASCII log 的 `log_bytes` > 字元數。
  - C5-⑥：`grep -c '進入流程的任務' README.md` ≥ 1。
- **對照死路**：D2–D8 全部改變 verdict 或加信任命題；這三項一個都不改。與 C1-6 最接近的死路是 D3（時間 proxy）——但 C1-6 不用時間，它看的是「最後一輪有 BLOCKER 且全部 `resolved`」這個**已在狀態檔裡**的事實。
- **若 owner 其實是刻意放棄**：那麼要做的是在 LEDGER §6 加三行「v7 C1-6／C5-⑥／C7 未實作，理由 X」。**沒有記載的放棄與遺漏無法區分**——這正是這個 repo 最怕的形狀。
- **更重要的是它揭露的事**：v7 是凍結過、經六輪審查的規格，而實作沒有逐條對上。監督者職責第 2 條（`spec-pipeline/SKILL.md` 表格）沒有在這個 repo 自己身上執行——或執行了但沒留痕。這件事放進 §4 Q1。

### R3 — 建議做：把設計文件 §0 的操作規則寫進 `spec-pipeline/SKILL.md` Step 3（這是 prompt 規則，不是閘門）

- **解決**：N2。目前唯一告訴操作者「resolve 完不算過」的文字，在一份模型永遠不會載入的 plan 文件裡。
- **形狀**：加約 3 行 prose。**會不會變成新表面？** 不會——它不引入機制，只是把 R2 的 C1-6 那行提示用操作者能提前讀到的方式再講一次。它的失敗模式是「被忽略」（prose 的固有失敗），所以 R2 的 C1-6 是它在腳本端的回聲；兩者一起，一個提前講、一個當場印。
- **腳本／prompt**：**prompt。明講：這不是閘門。** 腳本層的 `green_allowed` 語意不動（見 R3b）。
- **建議措辭**（放在 `:130`「S3 不 GREEN 不進 Step 4」之後）：
  > `green_allowed: true` 有兩種來源。最後一輪本來就零 BLOCKER ⇒ 可以凍結。最後一輪有 BLOCKER、靠 `--resolve` 全部標記 ⇒ **那是自我回報**（LEDGER §6 已知缺口），至少再跑一輪複審（`--prompt-block` 的素材）拿到零 BLOCKER 或 STOP 之後才凍結。凍結腳本擋不住這條路，是你自己要走對。
- **可否證條件**：靜態：`grep -n '自我回報' plugins/spec-pipeline/skills/spec-pipeline/SKILL.md` 命中。行為：R6 的三個數字之一——接下來 3 次真實 S3 裡，「resolve-all 後直接凍結、無複審輪」出現 ≥ 1 次 ⇒ prose 規則失效，重開 R3b 的討論。
- **對照死路**：D2 是「讓模型的裁決當閘門」；這條是反向——告訴操作者**腳本的 green 不是裁決**。D7（pending/promote 狀態機）加了狀態；這條不加。

### R3b — 建議不做（現在）：把 `green_allowed` 改成「最後一輪零 *解析出的* BLOCKER」（拿掉 resolve-all 路徑）

- **它會解決**：F1，而且是 fail-closed、零新狀態、刪一條路徑而不是加。形狀上是這份文件裡最像「對的答案」的東西。
- **為什麼不做**：design-green-semantics §2 第一列——「最後一輪零 BLOCKER 才放行」在 v2–v6 是主判準，死因 F17：五輪從未觀察到零 BLOCKER。**但那五輪全在 0.6.0 之前**：每輪 xhigh、無 R2 規則、target 每輪長 38 行。0.6.0 的 `--prompt-block` 自動帶「只報 BLOCKER、逐項核對、不發散」且 effort 降到 medium——在這組規則下 CLEAR 輪出現的機率**沒有任何數據**。
- **證據不足，需要先做的 X**：R6 的第二個數字。3–5 次真實 S3 裡若 R2/R3 出現過 CLEAR 輪 ⇒ 這條從「牆」變回「閘」，可以重開；若一次都沒有 ⇒ F17 成立，D2 家族維持死亡。
- **反向風險也要記**：CLEAR 若在 medium effort 下變得**太容易**（Codex 什麼都不說），那是橡皮圖章而非收斂——run2-R3 有一個「不蓋章」的樣本（設計文件 §3），只有一個。R6 記數字時要連同 CLEAR 輪的 `--prompt-block` 項目數一起記。

### R4 — 建議做（刪）：從 codex-review SKILL 拿掉模式 B

- **解決**：N6。一條 SKILL 寫著的路，走下去必然 `rc=21`。它讓「拿不到哨兵區塊」多一個成因，而 SKILL 自己在 `:268` 就得解釋 `rc=21` 有兩種成因。
- **形狀**：減。刪表格一列、Step 2 的模式 B 範例、「② `-C` 是位置問題」裡與 `review` 子命令有關的部分可保留（那是 CLI 事實）。
- **腳本／prompt**：prose。
- **可否證條件**：`grep -n '模式 B\|review --commit' plugins/spec-pipeline/skills/spec-pipeline/SKILL.md` 零命中（我查過：S3、S5 都寫模式 A）。若任一 Step 需要模式 B，此條作廢。fixture：拿任一無哨兵的 log `--record` → `rc=21`（既有測試已守）。
- **對照死路**：無，是刪除。
- **順帶**：README「刻意不做」列 `/codex:review`；模式 B 用的正是同一個 built-in reviewer。刪它讓 README 與 SKILL 一致。

### R5 — 建議做（減／合併）：SKILL 只留操作契約；歷史、量測、事故案例移到 LEDGER；effort 表合成一套

- **解決**：N4、N5、LEDGER F-過期。帶版本號的事實存兩份，過期時要改兩處，而這個 repo 的漂移史全是「兩份東西、沒有訊號」。
- **形狀**：減。具體：
  - codex-review SKILL「三條曾經寫錯的事實」整節 → LEDGER §1 已有 F-config、F-banner、F-版本號；SKILL 留一行「機器事實見 LEDGER §1，引用前先跑重驗指令」。
  - 「讀結論」的 `^codex$` 5 次案例 → LEDGER F-^codex$ 已有；SKILL 留結論句與指令。
  - 「prompt 要圈出 target」裡的 90.6% 量測 → LEDGER M1 已有。
  - **effort：刪 `:47` 表格列與 `:114-115` 的 R1/R2 表，只留 `:66-72` 那張依 target 行數的表**，並在 R2 列寫明「若 R1 已是 `low` 就維持 `low`」。`doctor.mjs:30` 註解改為「probe 用的固定值，非契約釘值」。
- **腳本／prompt**：prose（含 doctor 一行註解）。
- **可否證條件**：改後對 N5 那五個關鍵字，`grep -c` 在 codex-review SKILL ≤ 1（只剩指標）、在 LEDGER ≥ 1；`grep -c xhigh codex-review/SKILL.md` 只剩 target 表與共同前綴各一處；`validate-plugin.mjs` 綠、98 個測試綠（此條不動腳本行為）。負控：故意在 SKILL 留一條版本號事實 → 自己的 grep 抓到。
- **對照死路**：無。
- **不確定的部分**：SKILL 變短是否提高模型遵從度，**我量不到，也不主張**。此條只站在漂移面的論證上。

### R6 — 建議做：在下游專案真跑 3–5 次 F0→S5，每次只記三個數字，寫進 LEDGER §5

- **解決**：LEDGER §6（Mac／整條未驗收）；codex-review SKILL `:101`「唯一一次真實執行從未呼叫過 `fast-eligibility.mjs`」；design-2026-09-01 事實段「code review 全走模式 B」（即 S5 從未以模式 A 真跑）；§6c「迴圈離題最清楚的自指徵兆」——**目前所有校準資料都來自審查『審查流程自己的規格』**。
- **形狀**：不加任何東西。
- **這不是被否決的遙測**：3–5 行手寫，不彙總、不算趨勢、不做決策門檻——與 `review-state.mjs` 頭註區分「操作狀態 vs 統計彙總」同一條線。它的用途是**當 R3b、R7、R8 的可否證條件**，不是 ROI 實驗。
- **三個數字**（每次一行）：
  1. F0 有沒有被呼叫（`ls .claude/fast-baseline.json` 或 FULL 判定的 stderr）；
  2. S3 各輪 BLOCKER 數，有沒有 CLEAR 輪，CLEAR 輪的 `--prompt-block` 帶了幾項；
  3. 有沒有「resolve-all 後直接凍結、無複審輪」。
- **可否證條件**：這條本身的產出就是別條的否證器。若 5 次之後三個數字都無聊（F0 都跑了、CLEAR 有出現、沒有提前凍結）⇒ R3b 不必做、R8 不必做，這份文件一半的「不做」變成有數據的「不做」。
- **順序**：R1 之後（Mac 沒更新跑不了）、任何機制改動之前。

### R7 — 建議刪（排在 R6 之後執行）：`--blockers <n>` 人工覆寫

- **解決**：N7、LEDGER F11。它生產的輪讓「逐項核對上一輪」失效；而它存在的理由（解析失敗時免重跑）在 `FORMAT_SPEC` 由 `--prompt-block` 自動帶之後已經很弱。
- **形狀**：減。刪 `review-state.mjs:527-540` 解析、`:336-345` 分支、對應測試。
- **腳本／prompt**：腳本。
- **代價誠實記**：哨兵區塊被截斷（跳號 ⇒ `rc=2`）時唯一的路是重跑一次 invocation。這與 v7 對 `[FAIL]` 欄位採嚴格版（「格式疏漏燒一次 invocation」，設計文件 §3 B2）是同一個取捨立場。
- **「owner 手審當一輪」的情境**：不該用偽造的 `--rc 0 --log` 記一輪；該用 R3 停點的 `--resolve --how "owner 裁定…"`——那條路已存在且可稽核。
- **可否證條件**：R6 的 5 次裡，哨兵解析失敗且**重跑一次仍失敗**的次數 ≥ 2 ⇒ 保留 `--blockers`，此條作廢。否則刪。刪後 `node --test` 針對 `--blockers` 的測試要一起刪（不是改成過），負控：把分支加回 → 測試不該紅（因為已刪）→ 這正是為何要先刪測試。
- **對照死路**：不是新機制。v7 C1-2 剛把它硬化（1..50 + `--why`），這條是再往前一步：硬化證明了它是洞，洞的最終形狀是沒有。

### R8 — 建議不做（現在）：harness hook（Stop／PreToolUse）強制入流程或阻擋未 GREEN 收工

- **它想解的**：N8 + 那唯一一次記錄在案的繞過（F0 沒被呼叫）。
- **不做的理由**：
  1. 「有沒有進流程」的判定需要語意（這個 edit 是 S4 的一部分嗎？）——v7 §5 已裁定「無法辨識任務歸屬」，我沒有新論證推翻它。
  2. 純讀狀態檔的 Stop hook（有 S3/S5 stage、rounds>0、非 green ⇒ block）不需要語意，但它只抓「進了 S3 然後棄置」——`--start --force` 出現後這種案例記錄為零。
  3. N9 是活證據：人們真的會建這種 hook，而建出來的形狀是**模型出裁決**（`BLOCK:` 首行）。D1 的原形。
- **重開條件**：R6 顯示 ≥ 1 次「進 S3 後棄置」或 ≥ 2 次「從未進流程」。
- **對照死路**：D6（`--arm --watch`）是監管審查流程本身的自發增生物，吃掉 R3 四成 findings；hook 是同一屬。

### R9 — 建議不做：`ref/README.md` 候選池九條，全部

逐條，形狀比對（依據都是 subagent 二手描述，但因為我建議**不採**，二手就夠）：

| # | 候選 | 不做的理由 |
|---|---|---|
| 1 | 停滯偵測升級成閘、等待不算輪 | `divergence_hint` 已是提示版（R2 起）；升級成閘 = 讓腳本做「該拆該減」的價值判斷，LEDGER §4 明拒。「等待不算輪」已有：`rc=21` 不計輪 |
| 2 | Codex 不可用時降級 | 降級 = 假綠出口。`RC≠0` 一律 REVIEW_ERROR 是刻意的，invocation-retry 兩次後 STOP 問 owner 已是「顯式標注缺席」 |
| 3 | gate 稽核總表 | README「四件事都機械化了」表就是。再加一份 = 漂移面 |
| 4 | reviewer 禁止自報 PASS/FAIL | **已有**：哨兵區塊只列 findings，VERDICT 設計已死（設計文件 §3） |
| 5 | Fresh Reviewer | 與 LEDGER §2 直接衝突：審查者對看過的東西嚴格收斂，換人會失去「逐項核對上一輪」 |
| 6 | 多廠商一致性門檻 | 成本翻倍；瓶頸是審不完不是審不夠（LEDGER §2） |
| 7 | 五節證據格式 | 派工單已要求 `file:line` + 負控組實跑；再細 = 表面積 |
| 8 | 委派方向白名單 | sdd 不派整條流程（SKILL 明禁），用不上 |
| 9 | 「格式對但內容空洞」偵測 | 判空洞 = 判品質 = 散文。`[FAIL]` 欄位已是這件事能機械化的極限 |

### R10 — 建議不做：重啟 green 語意重設計

LEDGER §6 與設計文件 §7「一次只動一層」。在 R6 的數字出來之前，任何 green 語意的設計都是在 F17 的舊資料上推理。設計文件 §7 第 1 點（G1 禁止型設計）也**等 R6**——因為 G1 的實際發生率同樣是零數據。

### 附帶觀察（不排序，不算建議）

- `review-state.mjs:174` 的 `citations` regex `[\w./@-]+:\d+` 會把時間戳 `01:07` 當成引用位置。只影響 `trajectory`/`divergence_hint`（提示），不影響 verdict。
- `fast-eligibility.mjs:145` 寫 `fast-baseline.json` 用裸 `writeFileSync`，其他兩支狀態檔已走 `atomicWrite`。不一致，但 baseline 不在並行寫入路徑上。

---

## 3. 建議之間的依賴

```
R1（更新 Mac）
 └→ R6（真跑 3–5 次，記三個數字）
      ├→ R3b（要不要拿掉 resolve-all）：看數字 2
      ├→ R7（要不要刪 --blockers）：看解析失敗重跑率
      └→ R8（要不要 hook）：看數字 1、3
R2、R3、R4、R5 不依賴任何東西，可以現在做，全部零新表面。
```

---

## 4. 五個 owner 沒問但該問的問題

### Q1 這套流程現在最大的風險是什麼？

**保證被寫下來的速度快過被跑起來的速度。**

具體的一串：v7 凍結了 → 實作了 → 三項沒做、沒人發現（N1）→ F1 的唯一過渡措施因此不存在 → 而告訴操作者「resolve 完不算過」的規則只在 plan 文件裡（N2）→ 而讀這份文件的機器跑的是 0.1.0（N3）。每一節都有人審過；沒有人把節接起來看。

最可能出事而沒人擋的路徑：下游專案一個 normal 任務，R1 給 4 條 BLOCKER，操作者逐條 `--resolve`（每條都真的改了），`--status` 回 `green_allowed: true`，凍結，實作，S5 模式 A 一輪 CLEAR，GREEN。**沒有任何一輪看過修訂後的規格。** 這條路上每一步腳本都放行，SKILL 每一步都照做了。它與 v7 自己發生的事同構。

第二個風險是校準來源：所有 run1/run2 的數字都來自審「審查流程的規格」。§6c 已指出那是自指。在真實下游 target 上，divergence_hint 的三個條件、effort 分級的三個門檻、MAX_ROUNDS=3——沒有一個被驗過。

### Q2 有沒有該刪掉的東西？

有，四樣（§2 R4、R5、R7）：

1. **模式 B**——流程裡走不通的路。
2. **SKILL 裡的歷史與量測**——五條事實各存兩份。
3. **兩套 effort 表其中一套**——同一份文件內自相矛盾。
4. **`--blockers <n>`**——條件式，等 R6。

不該刪的（我逐一想過）：`divergence_hint`（有 run1 三輪的直接對應）、`--prompt-block`（LEDGER M5 有明確缺口對應）、鎖（M3 有踩到的事故）、F0（雖然沒真跑過，但它是「不讓模型判斷 fast」這條原則的唯一載體；刪它等於回到散文）、doctor（N3 就是它要抓的事，只是 Mac 上沒有它）。

### Q3 範圍漂移了嗎？

**漂了，而且漂的方向可以在 git log 讀出來。**

原始問題（README `:3-7`、commit `a3110e4`）：一條 pipeline，兩道異廠商閘門。現在：最近 20 個 commit 有 15 個在 `review-state.mjs`；它 548 行、57 個測試；F0 215 行從未真跑；S4 除了 `--verify-scope` 沒有任何工具；S5 從未以模式 A 真跑。兩份設計文件 41 KB 全在談 green 語意。

是不是同一件事？**一半是**：收斂是 pipeline 的真子問題，不解它 S3 就沒有出口。但另一半——S4 的實作紀律（監督者六職責）、S5 對真實 code 的審查、F0 的 allow_globs 在真專案裡怎麼起——是原始問題的主體，而它們停在 0.1.0 的成熟度。

另一個漂移訊號：`/fable` `/opus` 這對入口的唯一 payload（斷言模型）在 SKILL 裡的處理是「我不能切模型，停下來請 owner `/model`」。入口設計是刻意的（commit `3c0a03a`，理由寫在 SKILL），我不建議改——但要記：**它每個任務多一個人工步驟，而這個代價換來的「唯一難度訊號」從未在真實任務上被觸發過一次**。R6 順便記這個。

### Q4 有沒有更該先做的事？

**有。R1 然後 R6。也就是「什麼都不做，先實際用幾次」——但不是空手用，是帶三個數字用。**

理由不是謙虛，是這份文件有三條建議（R3b、R7、R8）的判斷**卡在零數據上**，而取得那些數據的成本是 3–5 次本來就要做的任務。在那之前加的任何機制，都會重演 D3–D8 的形狀：為了一個沒觀察過的失敗發明一個沒審過的東西。

R2–R5 可以與 R6 並行，因為它們全是減法或補帳，不改任何判定。

### Q5 `ref/` 85 個專案裡，有沒有哪一個讓 sdd 的某部分變成不必要？

**沒有一個整個取代某部分。** 但有三件事要誠實講：

1. **本機 `openai-codex` 1.0.4 的 Stop hook（N9）**：這是 sdd 缺的那種強制力（harness 層、模型躲不掉）配 sdd 拒絕的那種裁決（模型首行 `BLOCK:`）。它不取代 sdd，它是 sdd 的鏡像。如果有一天 owner 決定「強制力比裁決來源重要」，S5 的**強制**部分它已經做了——用的正是 README 拒絕的 shared built-in reviewer。
2. **Claude Code 原生 `code-review` skill**（本 session 工具清單裡就有）：它的 REVIEW.md 就是 sdd R2 規則的出處（設計文件 §3b 已逐字覆核）。effort 分檔、re-review convergence、nit 上限——sdd 抄的每一條它原生就有。**它不取代 S5 的唯一理由是同廠商。**
3. 所以最不舒服的問題是：**S5 這一半的存在理由是「異廠商」，而這個前提沒有被量過。** README 自己說「審查固定開，理由是品質，不宣稱省成本」——那是誠實的立場，但「異廠商比同廠商抓到更多真 BLOCKER」這個命題目前是信念，不是觀察。我**不建議**現在去量（會變成 ROI 實驗，owner 已否決，理由成立），但要知道 sdd 一半的重量壓在這個未量的命題上。

至於 `ref/` 裡的 hash 凍結類（planning-with-files 的 SHA-256 attestation、spec-kitty 的 Parity Hash）：二手描述說它們是「偵測後告警」不是「拒絕往下走」，弱於 `spec-freeze`。**我沒有開那兩個 repo 覆核**，因為結論方向是「sdd 不必改」，二手就夠。

---

## 5. 我沒有查證的東西

- **WSL 那台的狀態檔**。v7 有沒有真的 `--freeze`、S5 有沒有跑過模式 A、C1-6 是不是在 WSL 做了沒 push——我只看得到這台 Mac 與 git HEAD。N1 是 git 事實，不受影響；「流程沒在自己身上執行職責第 2 條」這個推論，若 WSL 上有相反證據就要改寫。
- **owner 是否刻意放棄 C1-6／C5-⑥／C7**。LEDGER 沒記，我當成遺漏處理；若是刻意，R2 的形狀變成「補 LEDGER 三行」。
- **`ref/` 任何一條機制描述**。我引用的全是「不採用」方向，所以沒去 fetch。唯一親自查的外部物是本機 `openai-codex` plugin（N9），那是本機檔案，不是 `ref/` 條目。
- **SKILL 長度對模型遵從度的影響**。R5 不站在這上面。
- **0.6.0 規則下 CLEAR 輪的出現率**。這是 R3b、R7、R8 三條的共同缺口，R6 就是為了它。
- **`citations` regex 的誤判在真實 log 裡實際發生過幾次**。附帶觀察那條是讀 regex 推的，沒拿真實 findings 跑。

## 6. 我可能錯在哪裡

1. **N1 可能是刻意的**。若 owner 在 0.2.0 → 0.6.0 之間有意識地砍了三項而沒記，Q1 的「沒人把節接起來看」要弱化成「接起來看了但沒留痕」。修法一樣（記進 LEDGER），嚴重度不一樣。
2. **R3b 的方向可能反了**。我假設 0.6.0 規則下 CLEAR 會變得可達；但也可能變得**太可達**——medium effort 的 Codex 在 R2 什麼都不說，那是橡皮圖章。F17 那道「永遠過不了的牆」可能其實是比較安全的失敗方向。R6 記 CLEAR 輪時要連 `--prompt-block` 項目數一起記，就是為了分辨這兩種。
3. **我可能高估「Anthropic 自家產品拒絕讓模型當閘門」這條論證**。我是 Anthropic 的模型；那條論證對我特別有說服力這件事本身該打折。這份文件裡依賴它的只有 R8、R9-4 的「不做」，方向與 LEDGER 一致，但重量請 owner 自己秤。
4. **我把「刪」排得很前面**，可能是因為 LEDGER 思考紀律第 4 條把「刪掉」寫成第一等公民，而我在照它的偏好答題。反證：R4、R5 各自有獨立於偏好的事實（N6 走不通、N5 兩份）。R7 比較弱——它的事實（N7）成立，但「弱到該刪」是判斷，所以我給了它條件與順序。
5. **Q5 第 3 點可能不公平**。「異廠商沒被量過」是真的，但「同廠商審查有共同盲點」有結構論證（同一訓練分佈），不需要量也能成立到某個程度。我保留這條是因為 sdd 把它當**核心主張**寫在 README 第一段，核心主張該知道自己的證據等級。
6. **這份文件本身就是 §6c 描述的那種產物**——一個站在流程外的模型，對流程下判斷，而 owner 是編輯。它的正確用法是簡報，不是閘門。哪幾條夠格做，是 owner 的裁決。
