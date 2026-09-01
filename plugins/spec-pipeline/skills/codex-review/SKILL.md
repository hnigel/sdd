---
name: codex-review
description: 用 Codex（異廠商）審規格或審 code。把呼叫契約、RC 判讀、與三條踩過的錯誤事實固化成單一來源
---

# Codex Review — 異廠商審查的單一來源

> 事實重驗日：**2026-09-01，codex-cli 0.144.1**（`codex --version`）。
>
> ⚠️ **每條帶版本號或機器狀態的事實，都必須同段附 30 秒可跑的重驗指令。**
> 理由見下方「三條曾經寫錯的事實」—— 這一段自己就過期過一次，而且沒有訊號。
>
> **不要用 `openai-codex` plugin 的 `/codex:review`** —— 那個走 shared built-in reviewer，
> 不是這裡要的做法（owner 2026-08-31 指定）。

---

## 選哪一種模式（先決定，選錯會拿不到你要的東西）

| 你要的 | 用哪個 |
|---|---|
| **自訂格式**（BLOCKER/POLISH、逐項複核上一輪）、審規格、問開放問題 | **模式 A：plain `exec`** |
| 只要一份不帶格式要求的 code 初審 | 模式 B：`review` 子命令 |

⚠️ **`--commit` / `--uncommitted` / `--base` 都不能與 PROMPT 併用**（實測 `rc=2`）。
所以**想要自訂格式就只能用模式 A** —— 在 prompt 裡自己寫死 review target 與基準 SHA。

> 實證：2026-08-31 的一個實際 session，code review 全走模式 B，**從來沒能傳自訂格式**；
> plan review 走模式 A，BLOCKER/POLISH 格式一次就生效，也是它讓一輪見底。

---

## 共同前綴（把環境釘死，不要靠 config 碰運氣）

```bash
CX=(codex -C "$PWD" -s read-only -a never exec -m gpt-5.6-sol -c 'model_reasoning_effort="xhigh"')
```

| 旗標 | 為什麼 |
|---|---|
| `-C "$PWD"` | 明確工作目錄。**位置有講究**，見下方表 |
| `-s read-only` | **review 不得改檔**。沒有這個，plain `exec` 是可以動工作樹的 |
| `-a never` | 不要求核准，背景跑得動 |
| `-m gpt-5.6-sol` | 不釘住就吃 per-machine config，換機會選錯模型 |
| `-c 'model_reasoning_effort="xhigh"'` | 同理。**見下方「反轉的結論」** |

---

## Step 1: 寫 prompt 檔（模式 A）

放在唯一暫存目錄，**不要用固定路徑**。

prompt 必須自己寫死這些（因為不能用 `--commit`）：
- review target：commit SHA / 檔案清單 / 工作樹範圍
- **上一輪的 findings 與「我怎麼處理的」**（要它逐項確認是否收口，否則它會重新發散）
- 輸出格式（見下方兩個實測有效模式）

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

**模式 B**（無自訂 prompt 的初審）：
```bash
codex -C "$PWD" -s read-only -a never exec -m gpt-5.6-sol \
  -c 'model_reasoning_effort="xhigh"' review --commit <sha> > "$tmp/out.log" 2>&1
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

### 跨 session 現在可以接續了

狀態在 `.claude/review-state.json`。換 session 直接 `--prompt-block <stage>`
就拿得到「上一輪的 findings ＋ 我怎麼處理的 ＋ 上輪逐字回覆」。

⚠️ 但 `rc=10` 時**不得聲稱逐項收口** —— 那代表真的沒有狀態，當成新 run 從初審開始。

⚠️ 這**不是** owner 否決的那個 log。被否決的是遙測 / retro / 統計彙總。
這裡存的是當前這一 run 的操作狀態，不跨 run 彙總、不算趨勢、run 結束就沒價值了。

---

## ⚠️ 三條曾經寫錯的事實（2026-08-31 更正）

**這一段存在的理由**：這些原本以「本機實測」的口吻寫在筆記裡，看起來很可信，
但其中三條在同一台機器的今天已經不成立。**帶版本號的實測筆記也會過期，而且沒有訊號。**

### ① effort 從 config 繼承，而 config 會漂移

```
2026-08-31 這份文件寫：  model = "gpt-5.6-sol" / model_reasoning_effort = "xhigh"
2026-09-01 同一台實際是：model = "gpt-5.5"     / model_reasoning_effort = "medium"
```
重驗：`cat ~/.codex/config.toml`

**同一台機器，一天之內就漂了。** 而且沒有任何訊號。

⇒ 結論不變而且更強：**不要靠 config，一律在呼叫點明寫 `-m` 與 `-c`。**
活證據：2026-08-31 那次真實 S3 審查的 log 首行是 `model: gpt-5.6-sol` /
`reasoning effort: xhigh`、rc=0 —— config 當時已經漂了，是明寫救了那一輪。
反向重驗（**不帶** `-c` 跑一次，看 stderr）：
`echo '只回答兩個字：ok' | codex -C "$PWD" -s read-only -a never exec -m gpt-5.6-sol -`
2026-09-01 實跑印出 `reasoning effort: medium` —— 當場繼承了漂移值。

⚠️ **banner 走 stderr，stdout 只有答案。** 想在腳本裡驗 model/effort 就不能用
`execFileSync`（只回 stdout），要用 `spawnSync` 取雙串流。

### ② `-C` 是**位置**問題，不是不支援

| 寫法 | rc |
|---|---|
| `codex -C X exec review` | **0** |
| `codex exec -C X review` | **0** |
| `codex exec review -C X` | **2** |

### ③ 「參數錯誤有上千行看起來正常的輸出」在本機重現不出來

三種 parser error 都是 `RC=2` 且**只有 5–11 行明確錯誤**。
原觀察可能來自別的失敗模式或舊版本，**不要拿它當除錯依據**。
（結論不變：**RC 一律寫檔再讀**。）

⚠️ 這一條原本綁著一個**本機從未出現過的版本號**（2026-09-01 查證：所有 log 與
`codex --version` 都是 `0.144.1`）。那個號碼想必是在另一台機器上讀到的，而筆記沒說是哪台。
這就是為什麼現在每條事實都要附重驗指令，也是為什麼驗收會 grep 舊版本號 ——
**寫死的版本號就是會過期的東西，留在文件裡只會讓人拿它當依據。**
重驗：`codex --version`

### 仍然成立的

- **沒有 `--fresh`**（舊筆記過時）
- `--commit` / `--uncommitted` / `--base` **都不能配 PROMPT**
- 額度耗盡 ⇒ `RC=1`，訊息在 log 尾巴

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
