---
name: codex-review
description: 用 Codex（異廠商）審規格或審 code。把呼叫契約、RC 判讀、與三條踩過的錯誤事實固化成單一來源
---

# Codex Review — 異廠商審查的單一來源

> ⚠️ **這份是呼叫契約，不是事實表。** 機器事實（版本、config 值、量測）全部在
> `plan/self-improve/LEDGER.md` §1，**引用前先跑它的重驗指令** ——
> 這份文件裡刻意不寫版本號，因為寫死的版本號就是會過期的東西。
>
> ⚠️ **每條帶版本號或機器狀態的事實，都必須同段附 30 秒可跑的重驗指令。**
> 理由見下方「三條曾經寫錯的事實」—— 這一段自己就過期過一次，而且沒有訊號。
>
> **不要用 `openai-codex` plugin 的 `/codex:review`** —— 那個走 shared built-in reviewer，
> 不是這裡要的做法（owner 2026-08-31 指定）。

---

## 只有一種模式：plain `exec` ＋ 自己寫的 prompt

```
codex ... exec ... - < prompt.txt
```

⚠️ **`--commit` / `--uncommitted` / `--base` 都不能與 PROMPT 併用**（實測 `rc=2`）。
所以**要自訂格式就只能走這條** —— 在 prompt 裡自己寫死 review target 與基準 SHA。

### ⚠️ 不要用 `codex exec review` 子命令

它的輸出**沒有哨兵區塊** ⇒ `review-state.mjs --record` 必然回 `rc=21`，這一輪不算數。
換句話說那是一條走下去一定拿不到結果的路，S3 與 S5 都不要用。
（它走的也正是 README「刻意不做」列的那個 shared built-in reviewer。）

> 實證：2026-08-31 的一個實際 session，code review 全走 `review` 子命令，
> **從來沒能傳自訂格式**；plan review 走 plain `exec`，BLOCKER/POLISH 格式一次就生效，
> 也是它讓一輪見底。

---

## 共同前綴（把環境釘死，不要靠 config 碰運氣）

```bash
# effort 依 target 大小決定，不要無條件 xhigh（見下表）
eff=xhigh   # 或 medium / low
CX=(codex -C "$PWD" -s read-only -a never exec -m gpt-5.6-sol -c "model_reasoning_effort=\"$eff\"")
```

| 旗標 | 為什麼 |
|---|---|
| `-C "$PWD"` | 明確工作目錄。**位置有講究**，見下方表 |
| `-s read-only` | **review 不得改檔**。沒有這個，plain `exec` 是可以動工作樹的 |
| `-a never` | 不要求核准，背景跑得動 |
| `-m gpt-5.6-sol` | 不釘住就吃 per-machine config，換機會選錯模型 |
| `-c 'model_reasoning_effort="…"'` | 同理。**值依 target 大小決定，不是固定 xhigh** —— 見下方唯一那張 effort 表 |

---

## Step 1: 寫 prompt 檔

放在唯一暫存目錄，**不要用固定路徑**。

prompt 必須自己寫死這些（因為不能用 `--commit`）：
- review target：commit SHA / 檔案清單 / 工作樹範圍
- **上一輪的 findings 與「我怎麼處理的」**（要它逐項確認是否收口，否則它會重新發散）
- 輸出格式（見下方兩個實測有效模式）

### ⚠️ effort 要跟著 target 大小走 —— 別用 xhigh 審幾行字

**這是實際咬到人的問題**：2026-09-01 一次幾行文字的 review 跑了超過 10 分鐘；
同日一份 88 行規格的 R1 實測 **13.3 分鐘**。成因是契約原本把 `xhigh` 無條件釘死。

依 target 行數選（**機械規則，不是判斷**，用 `wc -l` 或 `git diff --stat` 就決定得了）：

| target 大小 | effort | 理由 |
|---|---|---|
| **< 50 行** | `low` | 幾行字不需要最高推理預算。官方文件：`low`/`medium` **只報最有信心的 findings** |
| **50–300 行** | `medium` | |
| **> 300 行，或已知是 hard 任務的 R1** | `xhigh` | 要廣度時才用 |
| **R2 起（任何大小）** | 降一級，且不高於 `medium`；**R1 已是 `low` 就維持 `low`** | 見下方「第二輪起要降級」 |

⚠️ **釘死 `-m` 與 `-c` 這件事不變** —— 變的是 `-c` 帶什麼值，不是改回繼承 config
（config 會漂移，見「三條曾經寫錯的事實」①）。

### ⚠️ prompt 要圈出 target，否則它會重審整個 repo

即使 target 只有幾行，只要 prompt 說「對抗性地審」「請開檔核對」，
它就會去探索整個 repo —— 2026-09-01 實測：一輪開 7–17 個相異檔案，
log 絕大部分是 `nl -ba` 倒進來的檔案內容（實測比例見 LEDGER M1；那是 stdout 注入，
不是它在生成，但它仍然要讀完）。

⇒ target 小的時候，prompt 要明寫圍籬：

```
Review target 僅限：<檔案:行號範圍 或 diff>
不要重新審查整個 repo。只有在需要查證上面那段引用的事實時才開其他檔案，
並在 finding 裡註明你查了什麼。
```

**不要**因此拿掉「必須查證」的要求 —— 那是這個審查唯一值錢的地方。
圈的是**範圍**，不是**深度**。

### ⚠️ 幾行字本來就不該進 S3

S3/S5 是給**走完整流程的任務**用的。幾行文字的改動應該在 **F0 就被判 FAST**
而根本不進審查（`fast-eligibility.mjs --check <路徑>` 回 `rc=0`）。

走到 S3 通常代表兩件事之一：
- **F0 沒跑**（歷史上真的發生過：唯一一次真實執行從未呼叫過 `fast-eligibility.mjs`）
- 或該路徑不在專案的 `fast_path.allow_globs` 裡 ⇒ **fail-closed 判 FULL，那是正確行為**，
  但代價是完整審查。若那類路徑其實不需要審，**去改 `allow_globs`**，不要改審查強度。

### ⚠️ 第二輪起要降級 —— 不降級就會審到第七輪還在講風格

**這不是我們發明的，是業界處理同一個病的既有做法**（Claude Code 官方 code review 的
`REVIEW.md` 有一個叫 **re-review convergence** 的設定，原文說一條
「after the first review, suppress new nits and post Important findings only」的規則可以
"stop a one-line fix from **reaching round seven** on style alone"）。

**effort 看上面那張表就好（唯一一張）。** 這一節只講 prompt 規則。

為什麼 R2 起要降 effort：官方文件明說 `low`/`medium` 只報**最有信心**的 findings，
而 `high` 以上 "**may include findings the review is less sure about**"。
第一輪要廣，之後要準 —— 每輪都開 xhigh 等於主動選最會找碴的檔位，再對它的產出零容忍。

**POLISH 上限**：R1 的 prompt 要求「最多列 5 條 POLISH，其餘只給一個數量」。
理由同樣是官方文件那句：「**Prose and config files can be polished forever**」——
規格就是散文，可以被無限打磨。
（R2 起不必寫這條：那時規則已經是**完全不收新 POLISH**。）

### ⚠️ R2 起的規則現在由腳本帶，不要自己抄一份

`--prompt-block <stage>` 只在**已經有一輪**時才有輸出 ⇒ **它產出的必然是 R2 或更後面的複審輪**。
所以它一定會把這四條寫進素材裡：

1. 只報 BLOCKER 級別，不要提出新的 POLISH
2. 逐項確認上一輪是否真的收口
3. 不要重新發散到別的題目
4. BLOCKER 必須帶 `[FAIL] … -> …`

⇒ **把 stdout 整段貼進 prompt 就好，不要自己重寫一份**（重寫就是複製，複製就會漂移）。

⚠️ **effort 走 stderr，不在 stdout 裡。** stdout 是要整段貼進 prompt 的素材；
把「請用 medium」貼給 Codex 沒有任何作用 —— effort 是**呼叫端的旗標**。
所以 `--prompt-block` 會另外在 stderr 印一行提醒你把 `-c model_reasoning_effort` 降下來。

⚠️ 腳本強制的仍然只有**形式**：哨兵格式與 `[FAIL]` 欄位。
「只報 BLOCKER」是寫進 prompt 的**要求**，不是腳本能驗的東西 ——
Codex 真的多報了 POLISH，腳本照樣收（那不是假綠，POLISH 本來就不擋關）。

### BLOCKER 必須講得出失效情境

`FORMAT_SPEC`（`review-state.mjs` 單一來源，`--prompt-block` 會自動帶下去）要求每條 BLOCKER 寫成：

```
B1 BLOCKER 檔案:行號 [FAIL] 什麼輸入或狀態 -> 什麼錯誤結果
```

缺 `[FAIL] … -> …` ⇒ `rc=2`，**不做寬容降級**（靜默把 BLOCKER 改寫成 POLISH 會讓真缺陷消失，
這是審查者自己表達的偏好）。講不出具體觸發情境的請自己降級成 POLISH ——
那不是懲罰，是分級。

這條同樣有外部前案：Claude Code 的 **Verification bar**
（"behavior claims need a `file:line` citation in the source, not an inference from naming"）。

### 兩個實測有效的 prompt 模式

1. **BLOCKER / POLISH 兩級**，並明寫 **POLISH 只列標題、不展開**。
2. **逐項核對上一輪**：把「你上輪說 X，我改成 Y」寫進 prompt，要它確認**每一項**是否真的收口。
   ⇒ 不用手寫，跑 `review-state.mjs --prompt-block <stage>` 直接產生（它會**連格式要求一起帶下去**）。

### ⚠️ prompt 結尾**一定**要附這段（沒有它，結果無法被機械判讀）

```
最後請附上這個區塊，一條一行，編號從 1 連續，不要省略：

<<<FINDINGS>>>
B1 BLOCKER 一行描述（檔案:行號 + 為什麼會出事）
B2 BLOCKER 一行描述
P1 POLISH 一行描述
<<<END-FINDINGS>>>

沒有 BLOCKER 就只列 P 行；整個區塊可以留空，但不要省略區塊本身。
```

**為什麼要哨兵而不是靠散文** —— 2026-09-01 的實際事故：
`review-state.mjs` 原本把「含 BLOCKER 字樣的行」當一條 finding，結果

| 真實情況 | 數出來 |
|---|---|
| `**BLOCKER**` 標題底下列 `**B1**`…`**B6**` | **2**（只數到標題，還因為 log 裡重複出現而算兩次） |
| Codex 用 `nl -ba` 把原始碼倒進 log，註解裡就有 BLOCKER 字樣 | **19**（沒有一條是真的 finding） |

第一種偏低 ⇒ 收口那兩條就 `green_allowed: true`。
**一個專門防假綠的工具自己在製造假綠。**
⇒ 現在只認哨兵區塊，認不出來一律 `rc=21`，**絕不因為抓不到就當作零**。

> 佐證（真實案例）：某批 UI 修正 R1→R7 七輪才收斂，轉折點是第三輪**改變方法**；
> 另一批規劃 R1→R5，改成只問 BLOCKER/POLISH 之後一輪見底。
> 通則：同一問題重試上限兩輪，第三次必須換方法。

## Step 2: 跑（背景，RC 立刻保存）

```bash
tmp="$(mktemp -d)"
# ... 把 prompt 寫進 "$tmp/prompt.txt" ...
"${CX[@]}" - < "$tmp/prompt.txt" > "$tmp/out.log" 2>&1
rc=$?; printf '%s' "$rc" > "$tmp/rc"
echo "tmp=$tmp rc=$rc"
```

⚠️ 用 Bash tool 跑時**一定要 `run_in_background: true`** —— 高 effort 的 review 常
超過 10 分鐘，前景會被工具逾時砍掉（`exit 143`），而且 RC 檔不會被寫出來。

## Step 3: 判讀 RC（**先看 RC，再看內容**）

| RC | 意思 | 動作 |
|---|---|---|
| **0** | 正常結束 | 才可以解讀內容 |
| **1** | 一般執行失敗（**額度耗盡是其中一種**，訊息在 log 尾巴） | **REVIEW_ERROR**，review 其實沒跑完 |
| **2** | 參數解析失敗 | **REVIEW_ERROR**，修命令再跑 |

> **只有 `RC=0` 且 final response 完整非空**才算一輪有效審查。
> 任何 `RC != 0` **一律不得 GREEN**。

### 讀結論

```bash
N=$(awk '/^codex$/{n=NR} END{print n}' "$tmp/out.log")
sed -n "${N},\$p" "$tmp/out.log"
```

⚠️ **這只是給人看的，不要拿它做判定。** `^codex$` 出現幾次、在哪裡，都不可靠：
2026-09-01 一份正常結束的真實 review log（2999 行）裡它出現 **5 次**（行 84、1052、4590、9930、9937），
每次都只是 CLI 在新一輪推理前印的分隔字樣；而另一份中途結束的 log 裡它只出現一次且在推理開頭 ——
那會讓這行 awk 把整份逐字稿（含 Codex 用 `nl -ba` 倒進來的原始碼）當成結論。
判定一律交給 `review-state.mjs`，它只認哨兵區塊。
重驗：`grep -c '^codex$' <你手上任何一份 out.log>`

## Step 4: 輪數與收斂 —— 交給 `review-state.mjs`

⚠️ **不要自己數輪數。** 「這算第幾輪」「這條算不算收口」「CLI 掛掉算不算一輪」
三句都可以自我說服 —— 跟 F0 是同一個問題，所以同一個解法：機械化。

```bash
rs() { node "${CLAUDE_PLUGIN_ROOT}/scripts/review-state.mjs" "$@"; }

rs --start S3 --task "<這件事>"                    # 一個 run 開一次
rs --record S3 --rc "$rc" --log "$tmp/out.log"    # 每輪跑完立刻記
rs --resolve S3 --item B1 --how "<怎麼處理的>"      # 每修一條記一條
rs --prompt-block S3                              # 下一輪的 prompt 素材
rs --status S3                                    # green_allowed 在這裡看
```

⚠️ **用 function，不要用 `RS="node ..."` 然後 `$RS --flag`。**
那個寫法要 shell 對未加引號的展開做分詞：bash 會，**zsh 預設不會**（`SH_WORD_SPLIT` 關閉），
而 macOS 的預設 shell 就是 zsh —— 在那裡它會原樣失敗。function 在 bash/zsh/POSIX sh 語意相同。

| rc | 意思 |
|---|---|
| 0 | OK |
| 10 | 沒有前輪狀態 ⇒ 這次是 R1 初審（**不是錯誤**） |
| 20 | STOP_ASK_OWNER（R3 仍有 BLOCKER，或 invocation-retry 用完） |
| 21 | REVIEW_ERROR（RC≠0 或回覆空）⇒ **這次不算一輪** |
| 2 | 使用方式錯誤。含「哨兵區塊格式不合」（不合格式的行／編號跳號／等級對不上） |

⚠️ `rc=21` 有兩種成因：**review 沒跑完**、或 **prompt 沒帶哨兵格式**。
兩種都代表「這次沒拿到可用結果」，都不計為一輪、都不得放行。
真的要手動宣告條數用 `--blockers <n>`（明確、可稽核，但不是預設路徑）。

### ⚠️ `divergence_hint`：看到它就不要再審一輪

`--record` 在 **R2 起**可能多回一個 `divergence_hint` 欄位。觸發條件是機械的，三條同時成立：

- 這一輪的 findings **指的位置全部**是先前各輪沒指過的；
- findings 條數**沒有下降**；
- 至少有一個 `檔案:行號` 引用。

意思是：**這一輪打的是你上一輪為了收口而新加的東西** ⇒ 發散的是**修訂**，不是審查。
（run1 實測正是這個形狀：R2 打新機制 4/4、R3 打新機制 5/5，行數每輪 +38，
findings 穩在 4–5 條 —— 兩個速率都沒下降，那不是收斂，是穩態。）

⇒ **該拆該減，不是再審一輪。** 優先序：刪掉那個機制 > 縮小 review target >
誠實記為已知缺口 > 才是加新機制（而且加了就要預期下一輪打它）。

⚠️ **這是提示，不是閘門。** 它不改 `verdict`、不改 exit code、不寫進狀態檔。
「該拆該減」是編輯的價值判斷，腳本不做那個判斷（理由見 LEDGER §4）。

⚠️ 沒有出現 `divergence_hint` **不代表在收斂** —— 三個條件很窄，它只抓最明確的那個形狀。

### 跨 session 現在可以接續了

狀態在 `.claude/review-state.json`。換 session 直接 `--prompt-block <stage>`
就拿得到「上一輪的 findings ＋ 我怎麼處理的 ＋ 上輪逐字回覆」。

⚠️ 但 `rc=10` 時**不得聲稱逐項收口** —— 那代表真的沒有狀態，當成新 run 從初審開始。

⚠️ 這**不是** owner 否決的那個 log。被否決的是遙測 / retro / 統計彙總。
這裡存的是當前這一 run 的操作狀態，不跨 run 彙總、不算趨勢、run 結束就沒價值了。

---

## ⚠️ 機器事實一律去 LEDGER 查，不要信這份文件裡的數字

**帶版本號或機器狀態的事實不放在這裡**（`codex --version`、`~/.codex/config.toml` 的值、
log 行數比例、banner 走哪條串流…）。它們在 **`plan/self-improve/LEDGER.md` §1**，
每條附 30 秒重驗指令。**引用任何一條之前先跑它的重驗指令。**

為什麼要搬走：這些事實原本同時存在兩份文件裡，過期時要改兩處 ——
而這個 repo 的漂移史全部是「兩份東西、沒有訊號」。

> **活教材**：這一節的舊版曾經斷言「本機從未出現過 `0.150.0-alpha.7`，那想必是另一台機器」。
> 2026-09-03 在 owner 的 Mac 上跑 `codex --version`，答案就是 **`0.150.0-alpha.7`**。
> 那句話不是錯，是**它從來只對某一台機器成立，而文件沒說是哪台**。
> ⇒ 機器事實要標明「哪台、哪天、怎麼重驗」，否則它遲早會被當成普遍事實引用。

### 唯一留在這裡的兩類（因為它們是**呼叫契約**，不是機器狀態）

**① `-C` 是位置問題，不是不支援**

| 寫法 | rc |
|---|---|
| `codex -C X exec …` | **0** |
| `codex exec -C X …` | **0** |
| `codex exec … -C X` | **2** |

**② 仍然成立的**

- **沒有 `--fresh`**（舊筆記過時）
- `--commit` / `--uncommitted` / `--base` **都不能配 PROMPT**
- 額度耗盡 ⇒ `RC=1`，訊息在 log 尾巴
- **banner 走 stderr，stdout 只有答案** ⇒ 想在腳本裡驗 model/effort 不能用
  `execFileSync`（只回 stdout），要用 `spawnSync` 取雙串流
- **不要靠 config，一律在呼叫點明寫 `-m` 與 `-c`** —— config 會漂移（LEDGER F-config 漂移）

---

## ⚠️ 兩個會造成假綠的寫法

| 寫法 | 後果 |
|---|---|
| 固定 `/tmp/cx.log` / `/tmp/cx.rc` | **多 session 互相覆寫** |
| `cmd > log 2>&1; echo "RC=$?" > rc` | **整段 shell 回傳的是最後那個 `echo`（永遠 0）** ⇒ 漏讀 `.rc` 就是假綠 |

⇒ 用 `mktemp -d`，並讓 wrapper **回傳同一個 RC**。
（memory「別自己騙自己」：`deploy | tail` 吞過 exit code。）

---

## `</dev/null` 與讀檔

`</dev/null` 是**背景執行的防禦**（避免等 stdin），**不是**每個帶 PROMPT 的呼叫都需要。
從檔案讀 prompt 用 **`- < prompt.txt`**，不要 `"$(cat prompt.txt)"`。
