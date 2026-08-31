---
name: codex-review
description: 用 Codex（異廠商）審規格或審 code。把呼叫契約、RC 判讀、與三條踩過的錯誤事實固化成單一來源
---

# Codex Review — 異廠商審查的單一來源

> 這些事實由 codex 自驗 + 人工獨立複跑確認（2026-08-31，codex v0.150.0-alpha.7）。
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
   ⚠️ 這個格式不只是好讀 —— `review-state.mjs` 靠它機械數出還剩幾條沒收口。
   不用這個格式，腳本會回 `rc=2` 要你明講條數（**它不會因為抓不到就當作零**）。
2. **逐項核對上一輪**：把「你上輪說 X，我改成 Y」寫進 prompt，要它確認**每一項**是否真的收口。
   ⇒ 不用手寫，跑 `review-state.mjs --prompt-block <stage>` 直接產生。

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

## Step 4: 輪數與收斂 —— 交給 `review-state.mjs`

⚠️ **不要自己數輪數。** 「這算第幾輪」「這條算不算收口」「CLI 掛掉算不算一輪」
三句都可以自我說服 —— 跟 F0 是同一個問題，所以同一個解法：機械化。

```bash
RS="node ${CLAUDE_PLUGIN_ROOT}/scripts/review-state.mjs"

$RS --start S3 --task "<這件事>"                    # 一個 run 開一次
$RS --record S3 --rc "$rc" --log "$tmp/out.log"    # 每輪跑完立刻記
$RS --resolve S3 --item B1 --how "<怎麼處理的>"      # 每修一條記一條
$RS --prompt-block S3                              # 下一輪的 prompt 素材
$RS --status S3                                    # green_allowed 在這裡看
```

| rc | 意思 |
|---|---|
| 0 | OK |
| 10 | 沒有前輪狀態 ⇒ 這次是 R1 初審（**不是錯誤**） |
| 20 | STOP_ASK_OWNER（R3 仍有 BLOCKER，或 invocation-retry 用完） |
| 21 | REVIEW_ERROR（RC≠0 或回覆空）⇒ **這次不算一輪** |
| 2 | 使用方式錯誤。含「回覆裡抓不到 BLOCKER/POLISH，無法判定還剩幾條」 |

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

### ① effort 不是 `none`，本機是 `xhigh`

```
~/.codex/config.toml:  model = "gpt-5.6-sol"
                       model_reasoning_effort = "xhigh"
不帶 -c 實跑：          reasoning effort: xhigh
```
⇒ **傳 `-c model_reasoning_effort="high"` 是把強度往下調。**
owner 已明示不用省 codex token ⇒ 釘 `xhigh`，而且**明寫**（跨機可重現），不要靠 config。

### ② `-C` 是**位置**問題，不是不支援

| 寫法 | rc |
|---|---|
| `codex -C X exec review` | **0** |
| `codex exec -C X review` | **0** |
| `codex exec review -C X` | **2** |

### ③ 「參數錯誤有上千行看起來正常的輸出」不符 v0.150

三種 parser error 都是 `RC=2` 且**只有 5–11 行明確錯誤**。
原觀察可能來自別的失敗模式或舊版本，**不要拿它當除錯依據**。
（結論不變：**RC 一律寫檔再讀**。）

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
