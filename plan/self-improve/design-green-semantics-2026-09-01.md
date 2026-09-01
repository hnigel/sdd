# green 語意重設計 — 延後規格（不送審、不實作）

- 日期：2026-09-01。狀態：**起點文件**——owner 裁示拆分後，green 語意問題延後另走一次完整流程；本檔保存兩個 run、六輪審查累積的全部資產。出貨批在 `design-2026-09-01.md`（v7）。
- 讀者假設：你是日後接手這題的規劃者。這份檔案的目的是讓你**不必重走六輪**——哪些設計死過、怎麼死的、審查者說過什麼、還剩哪條活路，都在這裡。

---

## 1. 問題陳述（都是已驗證事實）

**F1 收口判定是自我回報**：`review-state.mjs:154`（`openBlockers = filter(!resolved)`）＋`:329`（`green_allowed: Boolean(r) && open.length === 0`）。`--resolve` 是呼叫端自我宣告；最後一輪的 BLOCKER 全部宣告完，無需任何複審輪即 `green_allowed: true`。README:5-7 核心主張是「兩道閘門都不是同一顆模型自己說過了」，收口判定卻恰好建在一次自我回報上。

**F10 真實操作者必須人工否決它**（transcript 逐字，`~/.claude/projects/-home-hnigel-game-01/380e9ed8-7ca6-43d3-9a12-d461316be570.jsonl`）：
> 「`green_allowed: true` 只是『六條都已標記處理』，**不代表通過**——規格從 357 改到 569 行，動了很多新機制，這些是 R1 沒審過的新東西。送 R2。」

失效模式具體：收口 BLOCKER 常引入新機制，而新機制沒被任何一輪審過。一個需要被人工否決的機械訊號比沒有訊號更糟——它在為錯誤方向背書。（這個失效模式後來在本任務的規格演化上連續三輪重演，見 §4。）

**F17 「零 BLOCKER」從未被觀察到，且 BLOCKER 計數本身就是模型判斷**（owner 觀察＋五輪第一手數據）：
- 數據：run1 findings `7 → 4 → 5`；run2 `7 → 2`。**沒有一輪為零。** findings 一輪比一輪窄（架構→機制→具名時點→細節）但不歸零。
- owner 逐字：「Codex 在 xhigh 之下，給它任何規格它都找得到東西……我們唯一的煞車是『三輪就問 owner』——那是輪數，不是價值判斷。」
- 關鍵：哪條標 BLOCKER 本來就是 Codex 的判斷。以「零 BLOCKER」當 GREEN 條件並沒有避開模型判斷，只是把它洗過一層五輪實測從未滿足的代理量。一道從未被觀察到通過過的閘，不能拿來當通過條件。
- 誠實限定：樣本僅五輪、target 屢變，不宣稱「零不可達」，只宣稱「把 GREEN 綁在無證據支持的前提上」。

## 2. 死過的設計（完整死因，勿復活原形）

| 設計 | 版本 | 死因（審查原文或判定） |
|---|---|---|
| 「最後一輪零 BLOCKER 才放行」 | v2-v6 主判準 | F17：五輪從未出現零 BLOCKER，是牆不是閘；且計數本身是模型判斷 |
| 時間 proxy（revise 後需 at>T 的清空輪） | v2 | run1-R2-B1：不綁 revision/run、不要求最後一輪，無關清空輪即可滿足 |
| `--record --revision <n>` 綁定 | v3 | run1-R3-B2 逐字：「正常漏貼或截斷 delta 後傳最新 n 即可讓未審修訂通過 `--check`，不需要主動偽造」——閘驗的是宣告不是事實 |
| restart 全文攜帶＋`<<<CARRIED-OVER:sha16>>>` marker | v3 | run1-R3-B3/P1：marker 在 log 只證明字串出現，不證明 Codex 逐項審過 |
| `--arm --watch` 審查中指紋 | v3 | run1-R3-B4/B5 打掉（守備由呼叫端選檔、未 arm 不擋） |
| C10：pending_sha＋新空輪才 promote | v5（**審查者自提**，run2-R1-B4） | **審查者自行撤回**，run2-R2-B2 逐字：「C10 未失效舊 S3 clearance，修訂後重跑既有 `--freeze` 可覆寫並清除 pending，使未經任何新複審的規格被 `--check` 判 OK；我撤回 R1-B4 的設計」 |
| mtime 守衛（拒收舊 log） | v5 | run2-R2-B1 逐字：「mtime 可被 touch／複製刷新且不含 invocation、stage 或 target provenance，舊或無關 clear log 仍能被記成放行輪」 |
| VERDICT SHIP/BLOCK＋`[FAIL]` 欄位＋輪數降級預算警報 | v6（owner P0 指令） | run2-R3 五條 BLOCKER（見 §3）；未及收斂即拆分出貨 |

結構教訓（run1-R3 診斷）：**每輪補丁本身開出新的未審表面**——findings 全集中打「最新加上去的那層」，7→4→5 不收斂；churn 全部集中在「怎麼判定 GREEN」。收斂訊號是「連續多輪無人反對」，不是輪數。

## 3. VERDICT 設計與 run2-R3 實地結果 —— ⚠️ **已被外部證據否定，勿照做**

> **2026-09-01 補：`green_allowed = 最後一輪 VERDICT SHIP` 這個設計不成立。**
> Greptile 團隊公開記載他們試過同一件事（讓 LLM 判斷自己產出的意見重不重要），
> 原文逐字：**「the LLMs judgment of its own output was nearly random」**，
> 並且「we simply could not get the LLM to produce fewer nits without also producing
> fewer critical comments」——嚴重度不是可獨立調的旋鈕，壓瑣碎意見會連critical一起壓掉。
> 來源：https://news.ycombinator.com/item?id=42451968 （已逐字覆核）
>
> 他們的成功解法是 embedding + KNN 比對歷史人工反饋，**判斷邏輯是統計的、不是再一次 LLM 推理**。
> 我們建不起那個資料集（一人使用量到不了統計門檻——與「刻意不做遙測」同一理由）。
>
> ⇒ **保留本節是為了記錄死因，不是為了日後照做。** 正確方向見 §3b。
> 唯一存活的部分是 `[FAIL]` 欄位（見 §3b 的 Verification bar），那條被外部獨立驗證有效。

## 3. VERDICT 設計與 run2-R3 實地結果（原始設計，供對照）

**v6 設計要點**（被拆分擱置，非被完整否決）：哨兵區塊首個非空行 `VERDICT SHIP|BLOCK`（缺漏/其他值 rc=2）；green = 最後一輪 SHIP；SHIP 併列 B 行 ⇒ rc=2（逼審查者顯式降級）；B 行必帶 `[FAIL] <輸入/狀態> -> <錯誤結果>` 欄位，腳本只驗存在不判品質，缺欄位在編號驗證後降級 POLISH（記 `demoted_from_blocker`）；MAX_ROUNDS=3 降為預算警報（R3+ 且 BLOCK ⇒ 記錄後 exit 20「預算用完問 owner」；SHIP 任何輪 rc=0）；人工 `--blockers` 輪無 VERDICT ⇒ 永不 SHIP。

**實地試跑結果（重要）**：監督者在 run2-R3 要求 Codex 於區塊外給 `<<<VERDICT>>>`。結果：**格式做得到，且 Codex 給的是 `BLOCK` 不是 SHIP**——第一個「審查者不會蓋橡皮圖章」的實證。「爛規格會被無腦 SHIP」的疑慮至少在這一個樣本上不成立。

**run2-R3 findings（對 v6 的五條 BLOCKER）**：
- **B2（監督者轉述其立場）**：Codex 明確反對「缺 `[FAIL]` 自動降級」——真 BLOCKER 會被靜默改寫成 POLISH 而消失；**它偏好嚴格替代方案**（缺欄位 ⇒ rc=2 整輪退回）。⇒ 日後採嚴格版，代價是格式疏漏燒一次 invocation。
- **B5（最有價值的一條線索，監督者轉述）**：G1（修訂未複審）有簡單解——**「pending 期間禁止 `--freeze`，或停用 `--revise`」**。注意形狀：**禁止一個操作**，不是增加一套狀態機——與失敗兩次的 C10 根本不同。禁止型設計的失敗方向天然 fail-closed，且不引入任何新狀態或新信任命題。**日後重啟這題，從這裡開始。**
- **B1（轉述）**：三種 VERDICT 格式互不相容的遷移問題（新舊 prompt/解析器混用期）。⇒ 日後設計要含遷移條款（單一來源 FORMAT_SPEC 同步改、舊格式 log 一律 rc=2 不寬容、部署後第一輪必是新格式）。
- **B3/B4**：同輪打 VERDICT 層；逐字未傳遞至本檔——完整原文在監督者備份的 review-state（狀態檔會被 `--start` 覆蓋，監督者已另存）。
- **P1（採納）**：輪數預算警報**不能**算「錯誤 SHIP」的緩解——它只在 BLOCK 時觸發，SHIP 直接通過，兩者防的不是同一件事。日後論證緩解時不得再引它。
- **P2（採納，用詞修正）**：VERDICT 的正確描述是「**沒有新增 trusted principal，但擴大了 trusted proposition**」——信任的主體不變（仍是異廠商 Codex，非規格作者），但被信任的命題從「它列的 BLOCKER 清單」擴大為「它的出貨裁決」。這比「不是新增信任」準確。日後規格照此措辭。

## 3b. 前案：別人怎麼解「審不完」——**核心診斷是角色沒有分離**

⚠️ **這一節是這份文件最重要的部分。** 它把「我們的問題」從「需要發明一個機制」
改寫成「我們漏了一個所有成熟審查制度都有的角色分離」。

### 診斷：審查者兼任了裁決者

我們的系統裡，Codex 的 findings **直接等於**放行判準（零 BLOCKER 才放行）。
也就是說審查者同時是編輯。**每一個成熟的審查制度都把這兩個角色分開**：

| 制度 | 分離方式 | 逐字出處 |
|---|---|---|
| 學術期刊（ICMJE） | 審稿人只有建議權 | 「A peer-reviewed journal is... **under no obligation to follow reviewer recommendations**, favorable or negative.」「The editor... is ultimately responsible」<br>icmje.org/recommendations |
| PLOS ONE | 編輯裁決哪些意見必須處理 + 輪數上限 | 「**Aim for no more than two rounds of revision** before a final decision.」編輯需「Determine which comments **must** be addressed... and which are non-essential」 |
| Kubernetes | 阻擋的預設值反轉 | 「**Avoid clicking the "Request changes" button**」「If you want to block a PR... leave a `/hold` comment. **Mention why**... optionally specify the conditions under which the hold can be removed」<br>kubernetes.io/docs/contribute/review/reviewing-prs/（已逐字覆核）<br>另 `/lgtm`（品質）與 `/approve`（合併授權）是兩個獨立訊號，後者限 OWNERS：kubernetes.dev/docs/guide/owners/ |
| LLVM | 退出阻擋要顯式聲明 | 「If you review a patch but **don't intend for the review process to block on your approval, please state that explicitly**.」 |
| Claude Code 官方 review | 生成式模型**不做裁決** | 「Findings are tagged by severity and **don't approve or block your PR**」「The check run **always completes with a neutral conclusion** so it never blocks merging」<br>裁決交給非生成式規則層：吐 `{"normal":2,"nit":1,"pre_existing":0}` 讓你自己的 CI 決定<br>code.claude.com/docs/en/code-review（已逐字覆核） |
| FDA 510(k) | 承認缺陷數無上限，改用 delta 收斂 | 「there is **no limit to the number of deficiencies** that FDA may generate」但「Any subsequent deficiencies will be **limited to issues raised by the information provided by the applicant in its response**」 |
| Google | 放行判準不是完美 | 「reviewers should **favor approving** a CL once it is in a state where it definitely improves the overall code health... **even if the CL isn't perfect**」「there is no such thing as 'perfect' code—there is only *better* code」 |

**最有話語權的那一方（Anthropic 自己的 code review 產品）明確拒絕讓生成式模型當閘門。**
這比任何論證都強。

### 可直接機械化的機制（腳本只驗形式，不判品質）

| 機制 | 出處 | 對我們的意義 |
|---|---|---|
| **findings 帶 blocking / non-blocking 標記** | Conventional Comments：「(non-blocking): ... **should not** prevent the subject under review from being accepted」；Google `Nit:`；COPE 要求分「essential」與「strengthen」 | 放行判準改成「有沒有未解決的 blocking 項」，而非「意見數是否為零」 |
| **阻擋要顯式 + 附理由 + 附解除條件** | Kubernetes `/hold` | 卡關不能是預設姿態 |
| **後續輪只審 delta** | FDA：subsequent deficiencies limited to responses | 直接解掉「新機制製造新表面」的正回饋 |
| **第一輪之後機械降級** | Claude Code REVIEW.md「**after the first review, suppress new nits and post Important findings only**」——原文明講這是為了「stops a one-line fix from **reaching round seven** on style alone」 | 逐字命中我們的病 |
| **低嚴重度數量上限** | 同上「report at most five nits, mention the rest as a count」；原文並直言「**Prose and config files can be polished forever**」 | 我們審的正是一份 markdown |
| **Verification bar** | 同上「behavior claims need a `file:line` citation in the source, not an inference from naming」 | **我們的 `[FAIL]` 欄位是獨立想到同一件事，這條存活** |
| **審查強度分檔** | 同上「At `low` and `medium`, the review reports only the findings it's **most confident in**... `high` through `max` broaden coverage and **may include findings the review is less sure about**」 | 我們每一輪都跑 xhigh，等於主動選最會找碴的檔位再對它零容忍 |

### `MAX_ROUNDS` 的意義要重寫

現在 R3 的 `rc=20` 問 owner 的是「**還要不要繼續？**」——那是計數器超時。

依 PLOS/ICMJE 模式，輪數上限的作用應該是**把裁決權交給編輯角色**，所以該問的是：
**「剩下這些意見，哪幾條夠格擋關？」**

⇒ **owner 本來就是編輯，流程已經把對的人放在對的位置，只是問錯了問題。**
這是這份文件裡成本最低、槓桿最高的一個改動。

### 這個失敗模式有名字

AutoGPT 案例研究把它記載為已知失敗模式（vectara/awesome-agent-failures）：
「write code → test it → find minor improvements → rewrite entirely → find different
improvements → repeat」，根因之一逐字：**「no concept of 'good enough' completion criteria」**。

另有實證支持「無外部真值來源的自我修正會讓品質下降」（arXiv:2310.01798，
CommonSenseQA 上 GPT-3.5 自我修正後 75.8% → 38.1%）。

### 找不到的（誠實記錄）

- **沒有**任何軟體工程論文給出「超過 N 輪後 review 邊際價值趨近零」的量化曲線。
  既有的邊際遞減證據（Cisco/SmartBear）講的是**單次審查時長與速度**，不是輪次，兩者不同軸。
- **沒有**人把「裁決/列問題分離」系統性寫成 code review 方法論發表。業界普遍在做，但未被命名。

## 4. 四個已知未守的缺口（v6-§7 全文遷入）

判準（監督者設定，可判定）：「若存在簡單、不引入新信任假設的設計能守住它，審查者直接講出來；講不出來，缺口記載成立。」原則③區分：原則③禁止「用聲明取代做得到的功能」；這裡是有實際失敗史的做不到（暫時）。**一道被證明擋不住的閘，比誠實記載「這裡沒有閘」更糟：它製造它擋得住的錯覺。**

- **G1 修訂過但未經 S3 複審的規格仍能通過 `--check`**（`spec-freeze.mjs:159-162` 當場更新 sha；`:129-141` 只比 sha）。兩方各試一次而失敗（§2 表：`--revision`、C10）。**但 run2-R3-B5 給了新活路（禁止型設計），此缺口是四者中最接近有解的。** 操作面：`--revise` 後把 `--delta` 貼進複審 prompt、記錄一輪；監督者抽驗 revise 後是否有放行輪。
- **G2 force-restart 後已知 BLOCKER 不被機械強制帶入新 run 的 R1**（marker 版已死）。操作面：監督者把前 run 未收口項放進新 R1 prompt、人工核對每項有下落。
- **G3 審查期間 review target 被改動無機械偵測**（`codex -C "$PWD"` 即時讀工作樹；`--arm --watch` 版已死）。操作面：審查中不編輯 target——run1/run2 都是監督者人工壓著執行的。
- **G4 `--record` 的 log 不含 provenance**——舊或無關 clear log 可被記成放行輪（mtime 版已死，run2-R2-B1 逐字見 §2）。操作面：`--record` 永遠緊接 codex 結束後對同一 mktemp 目錄執行；監督者抽驗 log banner 的 workdir/時間。

## 5. 信任邊界的演化（日後規格的分析框架）

1. v3 立場「防自我說服、不防主動偽造」——被 run1-R3-B2 推翻：存在**一般操作失誤**即可繞過的路徑，不需偽造。
2. v4 修正：信任只能放在「輸入是既成事實的搬運」（`--rc` 是 shell 剛回的數字、`--log` 是 codex 剛寫的檔），不能放在「輸入是語意主張」（「prompt 含到第 n 修」＝自我回報換名字）。
3. run2-R2-B1 再削：連「既成事實搬運」也有極限——「剛寫」本身無法機械證明（G4）。
4. run2-R3-P2 定稿框架：分析任何 green 設計時問兩件事——**誰被信任（trusted principal）**與**信任它什麼（trusted proposition）**。異廠商審查者作為 principal 是這套流程的根本假設，不可避免；設計的自由度在 proposition 的形狀（清單？裁決？欄位存在性？）與失敗方向（誤擋 vs 誤放）。錯誤 SHIP 的緩解必須是真緩解（P1：預算警報不算）。
5. `--blockers` 的值域論證仍然成立且已出貨：語意主張若值域被鎖到只能朝安全方向錯（n≥1 ⇒ 多報不放行），可以接受。

## 6. 審查歷史全紀錄

- **run1**（target：v1→v3 規格）：R1 7B/3P → v2；R2 4B/2P → v3；R3 5B rc=20 STOP——五條全打 v3 新發明，無一回打原始問題。owner 裁示縮小 → v4。
- **run2**（target：v4→v6 規格，新 run 起算、對 Codex 講明）：R1 7B/3P（含 B4 審查者自提 C10 設計）→ v5；R2 2B/1P（含審查者自行撤回 C10——先行承諾觸發）→ v6；owner P0 指令插入 VERDICT 設計；R3 5B rc=20 STOP——全打 VERDICT 層，但實地產出 `<<<VERDICT>>> BLOCK`（§3）。owner 裁示拆分。
- 各輪逐條處置矩陣在 git 歷史中的 v5/v6 版規格（`git log -- plan/self-improve/design-2026-09-01.md`，若已 commit）；未 commit 則以監督者備份為準。
- owner 裁示：下游專案移出驗收（run1-R1 後）；C8 採規劃委派否決整段委派（run1-R2 後）；縮小範圍（run1-R3 後）；C10 例外核准（run2-R1 後）→ 依先行承諾移除（run2-R2 後）；VERDICT P0 指令（run2-R3 前）；**拆分出貨（run2-R3 後，本檔由此而生）**。

## 6b. 高度問題：逐條審查看不見的那一類

⚠️ **這一節是這份文件目前唯一在談「審查本身站得太低」的部分。** 其餘各節都在談
「怎麼判定收口」——那是**終止**問題。這一節談的是**高度**問題，兩者不同，
而且高度問題不會因為終止問題解決而消失。

### 事實來源

owner 在另一個專案的一份規格上，於**第 11 輪逐條審查之後**，另外做了一次
**整體檢視**（沒走 spec-pipeline、沒碰 review-state），問的是逐條審查從未問過的問題：

1. 照這份做完，使用者的體驗實際上變成什麼？真的更好嗎？
2. 某個出口對使用者真的有價值，還是只是**為了讓規格過審查那道關的補丁**？
3. **範圍漂移了嗎？** 原始問題是 A，現在要改的是 B、C、D、E、F、G——還是同一件事嗎？
4. 分階段上線時，中間狀態自洽嗎？
5. **有沒有更該先做的事？**

11 輪逐條審查沒有產出這五個問題中的任何一個。

### 為什麼結構上產不出來

逐條審查問的是「**眼前這份東西哪裡有問題**」。它會忠實地確認你把它上一輪講的處理掉了，
但它看不見：

- **補丁的動機。** 一個由 findings 驅動的流程，會生產出**瞄準 findings** 而不是
  **瞄準使用者**的補丁。這對 findings 產生器本身是不可見的——那個補丁在它眼裡是收口。
- **累積的範圍漂移。** 每一輪的增量都是合理的；漂移只在跨輪累加時才看得出來。
- **機會成本。** 「有沒有更該先做的事」需要看流程外的東西，而審查者的視野被 review target 界定。

### 本專案自身的同構證據

這份規格的 run1 是 `7 → 4 → 5`，規格 242 → 279 → 318 行，**每一輪都在打前一輪
為了補洞而發明的機制**。打破它的不是第八輪審查，是 owner 跳出迴圈說
「拆分，先出貨定案那批」——一個站在流程外的價值判斷，與上述整體檢視同一形狀。

⇒ **這不是 owner 紀律好，是流程缺了一個關卡。** 靠人記得跳出來，正是這個 repo
在別處拒絕接受的那種安排。

### 候選機制一：固定的高度檢查題組

上面五個問題不是那個任務專屬的，對任何規格都成立。做成**進 S4 之前必問**的關卡：

- 題組固定（單一來源，跟 `FORMAT_SPEC` 同樣待遇），**必須逐題明確 Yes/No，不接受模稜兩可**；
- 腳本**只驗「這組問題被問過且每題都有 Yes/No」**，不判斷答案品質——
  判斷品質就回到散文，那是原則①禁止的。與哨兵區塊同一手法；
- 觸發時機待定：每個 run 一次、或輪數 ≥2 時強制。**別預設「多做總比少做好」**——
  這份文件整份都是「多加一層就多一片未審表面」的紀錄。

### 候選機制二：出處標註 + 利益衝突聲明

owner 在那次整體檢視的 prompt 裡寫了**利益衝突聲明**：那份規劃大部分是檢視者
自己的產出，所以要求它**對自己那幾段更嚴格**，特別是「最後才加、只經過一輪審查」的部分。

本專案有這個手法有效的直接證據：**C10 的設計出處被註明在四處**（run2-R1-B4，
審查者自提），下一輪審查者**撤回了自己的設計**（run2-R2-B2 逐字：
「……我撤回 R1-B4 的設計」）。**沒有那個標註，那次撤回不會發生**——
它不會知道那是自己的東西，也就不會被要求對它更嚴格。

⇒ 機械形式：每個變更項必帶 `provenance`（誰提的、經過幾輪審查）。
腳本只驗欄位存在。檢視時把「自己提的」與「只經過一輪的」標出來。

⚠️ 誠實的限制：這**擴大了 trusted proposition**（見 §5）——我們信任檢視者會照
聲明對自己更嚴格。沒有機械物能強制它做到。它的價值在於**讓利益衝突可見**，
不在於消除利益衝突。

## 7. 日後重啟的建議起點（非規格，僅路標）

1. 從 **G1＋run2-R3-B5 的禁止型設計**開始（「pending 期間禁止 `--freeze`／停用 `--revise`」）——形狀對、範圍小、fail-closed，是六輪中唯一由審查者提出且未被推翻的活方案。
2. VERDICT 若重啟：採 Codex 偏好的嚴格版（缺 `[FAIL]` ⇒ rc=2 整輪退回）；含格式遷移條款；緩解論證不得引預算警報；措辭用 trusted proposition 框架。
3. 驗收沿用原則⑤（hermetic＋行為改變/回歸保留兩類）；收斂判準用「連續 N 輪無人反對」而非輪數。
4. 一次只動一層。六輪的教訓不是哪個設計錯，是**同時重設計判準與機制**讓每一輪都在審沒審過的東西。
