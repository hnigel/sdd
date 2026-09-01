# Handoff — 給維護這個 plugin 的人

> ⚠️ **這份不是使用指南。** 只是想在自己的專案用這套流程 ⇒ 讀 `README.md` 的「快速上手」。
>
> 這個 repo **就是** spec-driven pipeline 本身；它是被自己的流程做出來的
> （規劃 → Codex 審規格 → 實作 → Codex 審 code）。

---

## 00. 開工前先讀 `plan/self-improve/LEDGER.md`

**查過的問題不要再查一次。** 那份文件收著：

- 已查證的機器事實（codex 版本、config 漂移、banner 走 stderr、zsh 分詞、
  plugin 更新比版本號不比 commit…）**每條附重驗指令**
- **死路清單**：八個試過且失敗的設計，附死因。勿復活原形
- 為什麼 review 會「審不完」的診斷，以及可操作的判準
- 外部前案（別人怎麼解，附 URL）
- 量測過的東西（Codex log 有 90% 是檔案傾印、跨輪重複讀取…）別再重算

⚠️ 查完新東西**回來寫進那份**，不要只留在 commit message —— 沒有人會回頭翻 commit。

---

## 0. 改完 `plugins/` 一定要 bump 版本號

**否則使用者的 `claude plugin update` 會靜默無效。**

2026-09-01 實測：推了四個 commit（含新檔 `doctor.mjs`）但沒動版本號，
使用者跑 `claude plugin update spec-pipeline@sdd` 得到：

```
✔ spec-pipeline is already at the latest version (0.1.0).
```

cache 仍釘在舊 commit，`doctor.mjs` 根本沒被抓下來。
**它回報的是成功的語氣，所以沒有人會去查。**

⇒ 兩處要同時改（`validate-plugin.mjs` 會檢查兩邊一致，不一致會紅）：

```
plugins/spec-pipeline/.claude-plugin/plugin.json   version
.claude-plugin/marketplace.json                    plugins[].version
```

⇒ 使用者端驗證：`claude plugin list` 看版本，或跑 doctor 看 `plugin_pin` 的 sha。

## 1. 這裡有什麼

```
.claude-plugin/marketplace.json          ← marketplace 入口
plugins/spec-pipeline/
├── .claude-plugin/plugin.json
├── commands/{fable,opus}.md             ← 各 ~17 行，只帶入「指定的規劃模型」
├── skills/spec-pipeline/SKILL.md        ← **流程主體**（唯一來源）
├── skills/codex-review/SKILL.md         ← Codex 呼叫契約（唯一來源）
├── scripts/
│   ├── fast-eligibility.mjs             ← F0 機械判定（不呼叫任何模型）
│   ├── review-state.mjs                 ← 輪數 / 收口 / 跨 session resume
│   ├── spec-freeze.mjs                  ← 規格凍結 + delta 複審
│   ├── validate-config.mjs              ← 照 schema 驗 pipeline.json
│   └── lib/validate-config.mjs          ← 極小 schema 驗證器（零依賴）
├── schemas/pipeline.schema.json         ← 設定形狀的唯一來源
└── tests/*.test.mjs                     ← `node --test` 零依賴，數量不寫死
scripts/validate-plugin.mjs              ← repo 自己的形狀檢查（不會被裝到使用者機器上）
.githooks/pre-push                       ← push 前把上面兩件跑完，紅的擋下來
```

⚠️ **兩個指令刻意很薄**。流程內容**只放 skill**，指令複製一份就會漂移。

## 2. 改東西之前

```bash
node --test plugins/spec-pipeline/tests/*.test.mjs
node scripts/validate-plugin.mjs
```

⚠️ **在新機器 clone 之後要跑一次**（hook 不會跟著 clone 過來）：

```bash
git config core.hooksPath .githooks
```

沒跑這行 = push 前完全沒有檢查，而且**不會有任何提示**。

⚠️ 改判定腳本一定要**附負控組**：把機制改壞 → 測試真的紅 → 還原。
沒有負控組的「測試通過」證明不了測試在測東西。

## 3. 刻意不做（不要好心加回來）

- ❌ **log / 遙測 / retro** —— owner 決定。一個人用的量在統計上到不了任何決策點。
  代價誠實記錄：「哪類 must-fix 反覆出現」永遠不會被彙總
- ❌ **審查 ROI 實驗** —— 同上（每週 1–4 件 eligible task，20 pilot + 80 confirmatory
  要 25–100 週）。審查固定開，理由是品質，**不宣稱省成本**
- ❌ `openai-codex` plugin 的 `/codex:review`（走 shared built-in reviewer）
- ❌ **GitHub Actions** —— 改用 `.githooks/pre-push`。
  private repo 的 Actions 要付費額度，加回來只會每次 push 寄一封失敗信

## 4. 這套東西自己踩過的坑

1. **「deterministic」寫在 Markdown 裡就不是 deterministic** —— 所以 F0 是腳本
2. **`--commit` 與 PROMPT 互斥** —— 想要自訂 review 格式就只能用 plain `exec`
3. **`cmd > log; echo RC=$? > rc` 整段回傳 0** —— 漏讀 `.rc` 就是假綠
4. **effort 從 per-machine config 繼承，而 config 會漂移**（2026-09-01 實證：同一台一天內從 `xhigh` 漂到 `medium`）⇒ 呼叫點必寫，不要推論「傳 X 是往上還往下」
5. **「本機實測過」不等於「永遠成立」** —— 有三條帶版本號的實測筆記後來就不成立了
6. **`--verify-scope` 的基準必須是入場 commit，不是 `HEAD`** —— 寫 `HEAD` 的話
   implementer 一 commit 就 diff 不出東西，回報 0 檔 0 行的**假綠**
7. **fail-closed 要看方向** —— `allow_globs` 拼錯會 FULL（安全），
   `deny_globs` 拼錯卻讓 deny 整條靜默失效而**放行**。所以未知鍵一律 `rc=2`
8. **用免責聲明取代功能，是在騙自己** —— 「不支援 resume 所以不得聲稱收口」
   那句話擋不住任何事，該做的是把狀態存下來
