# opencode-priority-fallback

[opencode](https://opencode.ai) 2.x 的插件：讓每個會話盡量使用優先序最高、目前可用的模型。

- **不干預 opencode 自己的重試。** 目前的模型重試全部失敗、執行真的停下後，才切到下一個模型，並自動送出 `continue`。
- **失敗的模型冷卻 10 分鐘。** 錯誤有指定更長的等待時間（`retryAfterMs`，例如每日免費額度要等到隔天重置）時，就冷卻到那個時間，最多 24 小時。冷卻結束後，在下一步結束時或你發新訊息時切回去。
- **全部模型都在冷卻時，等最早結束冷卻的那個再試。** 無限次重試，不需要人工介入。

和 [opencode-runtime-fallback](https://www.npmjs.com/package/opencode-runtime-fallback) 的差別：runtime-fallback 在第一次出錯時就攔下原生重試並換模型；這個插件則讓原生重試先跑完。

## 需求

- opencode 2.x，使用 V2 插件 API（`export default { id, setup }`）。在 **opencode 2.1.4** 上驗證過。
- 不需要任何相依套件，只用 Node 內建模組。

## 安裝

1. 把 `priority-fallback.js` 複製到 opencode 的插件資料夾：

   ```bash
   mkdir -p ~/.config/opencode/plugins
   cp priority-fallback.js ~/.config/opencode/plugins/
   ```

2. 編輯檔案開頭的 `PRIORITY`，換成你自己的模型清單（格式是 `provider/model`，優先序高的在前）：

   ```js
   const PRIORITY = [
     "opencode/deepseek-v4.1-flash-free",
     "opencode/glm-5.3-flash-free",
     "nvidia/deepseek-ai/deepseek-v4.1-flash",
     "nvidia/minimaxai/minimax-m3.1-flash",
     "nvidia/z-ai/glm-5.3-flash",
   ];
   ```

3. 重啟 opencode。opencode 也會偵測插件檔案變動並自動重新載入。

**不要同時啟用 opencode-runtime-fallback。** 它會在第一次出錯時攔下原生重試，和這個插件的行為衝突。

## 運作方式

### 切換到下一個模型

收到 `session.execution.failed`，代表 opencode 的原生重試已經用完，或錯誤本來就不會重試。這時：

1. 錯誤類型屬於「會切換」的那一類，就讓目前的模型進入冷卻。冷卻時間是 `COOLDOWN_MS` 和錯誤的 `retryAfterMs` 中較長的那個，上限 `MAX_COOLDOWN_MS`。冷卻是全域的，所有會話共用。
2. 從 `PRIORITY` 裡挑第一個「沒在冷卻、而且 context 裝得下」的模型，切過去（`session.switchModel`）。
3. 送出 `continue`，讓會話繼續工作。

如果所有能用的模型都在冷卻，就等最早結束冷卻的那個，到時候再重複上面的步驟。

等待期間，只有在新的 execution 真的開始跑步驟（`session.step.started`）時才會取消等待，例如你自己發了新訊息。opencode 在失敗後有時會立刻開一個不跑任何步驟、馬上就成功結束的空 execution，這種不會取消等待。

### 切回優先序更高的模型

在每一步結束時（`session.step.ended`），以及你送出新訊息、訊息開始執行之前（`prompt` hook），只要有優先序更高的模型已經結束冷卻、而且 context 裝得下，就切回去。`switchModel` 從下一次請求開始生效，所以長時間自動執行的任務中途也會切回。

### context 容量

模型的上限從 opencode 讀取（`ctx.model.list()`），會跟 `opencode.json` 裡的 `limit.context` 覆寫值同步。會話目前的用量加上 `CONTEXT_HEADROOM`（預設 32,000）超過某個模型的上限時，就跳過那個模型，避免切過去馬上超限。如果沒有任何模型裝得下，就選上限最大的，交給 opencode 自動壓縮。

### variant（推理強度）

各模型的 variant 名稱不一樣，例如 `max` 和 `thinking`。切換時依序這樣決定：

1. 這個會話之前在目標模型上用過的 variant
2. 目標模型有同名的 variant 就沿用
3. 都沒有就用目標模型最強的那個（清單最後一個）
4. 原本就沒設 variant（或是 `default`），就維持預設

### 錯誤分類

| 錯誤類型 | 清單內的模型 | 清單外的模型（手動選的） |
|---|---|---|
| `rate-limit`、`internal`、`transport`、`timeout`、`connect`、`unknown`、`invalid-output` | 冷卻並切換 | 60 秒後送 `continue`，留在同一個模型 |
| `error`、`quota`、`free-limit`、`auth`、`no-route` | 冷卻並切換 | 不處理 |
| `invalid-request`、`content-filter`、`unsupported-operation` | 不處理 | 不處理 |
| 錯誤訊息看起來是 context 超限、無效請求或取消 | 不處理 | 不處理 |

另外也不會處理這些情況：你手動中止、子代理（subagent）的子會話、已封存的會話。

### 手動選擇模型

- **選了清單外的模型**：插件不會切換這個會話，只會在暫時性錯誤後自動 `continue`。
- **選了清單內的模型**：照優先序管理，之後也可能被切回優先序更高的模型。

## 可調整的常數

| 常數 | 預設值 | 說明 |
|---|---|---|
| `PRIORITY` | 見上方 | 模型優先序 |
| `COOLDOWN_MS` | 10 分鐘 | 失敗模型的冷卻時間 |
| `MAX_COOLDOWN_MS` | 24 小時 | 錯誤的 `retryAfterMs` 比 `COOLDOWN_MS` 長時，冷卻時間的上限 |
| `THROTTLE_MS` | 60 秒 | 清單外模型失敗後，等多久才送 `continue` |
| `MIN_GAP_MS` | 5 秒 | 同一個會話兩次 `continue` 之間的最短間隔 |
| `CONTEXT_HEADROOM` | 32,000 | 判斷 context 裝不裝得下時預留的空間 |
| `CONTINUE_TEXT` | `continue` | 自動送出的訊息內容 |

## Log

每次冷卻、切換、送出 `continue` 都會記錄在：

```
~/.local/share/opencode/log/priority-fallback.log
```

（有設定 `XDG_DATA_HOME` 的話，會放在 `$XDG_DATA_HOME/opencode/log/`。）

範例：

```
cooldown opencode/claude-sonnet-5-5 for 600000ms after type=provider.quota status=402 message="Upstream request failed: Insufficient account funds"
switch session=ses_... opencode/claude-sonnet-5-5 -> opencode/deepseek-v4.1-flash-free (recover, tokens=?)
sent continue session=ses_... attempt=1 model=opencode/deepseek-v4.1-flash-free
```

## 安全性

- 不會連網。插件只透過 opencode 提供的 API 操作會話。
- 不會刪除任何檔案，只會附加寫入自己的 log 檔。

## 限制

- **冷卻狀態只存在記憶體裡**，opencode 重啟後就清空。
- **opencode 剛啟動的前 10 秒**，`ctx.model.list()` 回傳的是 models.dev 的原始上限，還沒套用 `opencode.json` 的覆寫值。這段期間讀到的值不會快取，但如果剛好在這幾秒內發生失敗，判斷 context 是否裝得下時用的會是原始值。
- **每次切換都會在對話紀錄裡留下一筆「model switched」**。

## 測試

```bash
npm test
```

測試用假的插件 ctx 模擬 opencode 的事件和 API，並用 `node:test` 的 mock timers 快轉時間，不需要真的連到 opencode 或任何模型。需要 Node 20.4 以上。

## 授權

[MIT](LICENSE)
