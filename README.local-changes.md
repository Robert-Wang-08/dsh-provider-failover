# dsh-provider-failover (dsh-deepseek-keypool) — 本地改动说明

除上游 README 描述的行为外，本机版本增加了三项改动（详细设计、验证与回滚见
`../dsh-config-pack/docs/provider-failover-notice.md`）：

1. **会话内可见的转移通知**：按 sessionId 归档（内存 + `$DSH_HOME/plugins/provider-failover/notices.jsonl`），
   经 `GET /provider-failover/notices` 取数，客户端在 `conversation.input.dock` 显示
   「原因 + 结果 + turn/step」。不写 Session surface、不进模型上下文。
2. **按失败类别的重试策略**（`retryPolicies`）：TRANSPORT 5s×5（30s 预算）、RATE_LIMIT 15s×3、
   **SERVER 5s×5（30s 预算）**；QUOTA/AUTH/凭据类/NO_ADAPTER 立即切换；未列出的错误码一律立即切换。
   并补齐 `websocket error` / `websocket` 消息兜底与其 TRANSPORT 归类。

   SERVER 档于 2026-10-16 由 **3s×2（`budgetMs` 15s）改为 5s×5（`budgetMs` 30s）**。起因（实测）：
   codex-relay 对同一个子代理请求连续三次返回空体 `502 status code (no body)`（单次请求约 15s），
   旧档的 2 次重试 × 3s 退避在 36s 内就交出了路由；接棒的 openai-codex 报 `usage limit`、
   kimi 报 403 周额度，tier1 三条全灭，子代理整轮失败且调用方看不到原因。新档给短时过载留
   30s 自愈窗口，预算耗尽才升档/交回宿主。**空体 502 已由 `effectiveFailureCode()` 折算为
   `SERVER`**（见上游 README「生效码」一节），因此这一档就是 502 的实际重试档。
   覆盖方式：profile patch 里 `- id: dsh-deepseek-keypool` 的 `config.retryPolicies` 可按类别整体覆盖
   （加载期校验 `budgetMs >= delayMs`，否则拒绝加载）；本机没有覆盖，用的是这里的默认值。
   回归：`node probe/smoke-config.mjs`（期望 `FAILURES: 0`）。
3. **`ranking.sameTierFirst`**（默认 false）：打开后失败先在**同档内**互备，整档耗尽才升档。
4. **失败原因细分（`AUTH` 不再是一句空话）**：通知与设置页除错误码外，再显示**具体原因**
   （额度/余额不足、权限不足：该令牌无权使用该模型、凭据无效、凭据缺失、被限流）与
   **脱敏后的上游原文摘要**。

   背景（实测 2026-10-16）：tokeniss 对 `claude-opus-5-5` 返回
   `403 {"message":"预扣费额度失败, 用户剩余额度: ¥1.040956, 需要预扣费额度: ¥1.192114"}` 且
   `code:"AUTH"`，提示里却只写 `AUTH`——真因是**余额不足**；同期 anthropic-relay 对同一模型
   返回的 403「该令牌无权访问模型」也是 `AUTH`，真因却是**模型未授权**。两者处置完全不同
   （充值 vs 换来源/换档），而归一化码区分不了。

   - 判定表 `failureReasons`：内置中英文词条（`DEFAULT_FAILURE_REASONS`），按**从上到下首次命中**，
     故具体词先于通用词；配置层只能**追加**词条，不会把内置表整体挤掉。
     未知 reason id 与空数组都记配置错误（拼错的键不会静默失效）。
   - **只影响展示**：不参与 `isSwitchable` / `retryPolicies` / 冷却 / key 轮换的任何判定，
     因此增删词条永远不会改变切换与重试行为（回归里有一条专门断言这一点）。
   - `AUTH` 下的**换 key 行为保持不变**：余额与模型授权都可能靠"换一把有权限/有钱的 key"治好，
     所以 `KEY_ROTATION_CODES` 不动；细分只负责告诉用户"换 key 有没有可能有用"。
   - 拿不准时如实写「授权被拒（未细分到具体原因）」，不替用户下结论说"凭据无效"。
   - 原文摘要经 `sanitizeForRanking` 抹掉密钥形状并截断到 200 字符，不进模型上下文、不进 Session surface。
   - 同一个细分也用在 **`/failover-probe` 全量测试**的展示上：`AUTH` 不再一律显示「凭据无效」，
     而是余额不足 / 权限不足 / 凭据无效（`status` 码与 QUOTA 等既有标签保持不变）。

   回归：`node probe/smoke-config.mjs`（期望 FAILURES: 0），新增
   「失败原因细分（AUTH 类提示）」与「端到端：AUTH 类失败在通知里区分具体原因」两组断言。

5. **content_filter（上游内容安全拦截）纳入切换（2026-10-27）**：OpenAI 兼容接口可能以
   HTTP 200 + `choices[0].finish_reason = "content_filter"` 结束（上游内容安全策略拦截）。
   pi-ai 的 `mapStopReason` 把它折成 `errorMessage: "Provider finish_reason: content_filter"`，
   宿主 `classifyPiAiError` 认不出 → `PI_AI_ERROR`；该码不在宿主默认重试码表里，插件的
   `failurePatterns` 此前也不含它，于是 `isSwitchable` 归入 other、原样交回宿主——用户只看到
   一句「本轮运行失败Provider finish_reason: content_filter」，既没重试也没换来源。现在：

   - `failurePatterns` 增加 `content_filter` / `content filter`，生效码折算为 `CONTENT_FILTER`；
   - `retryPolicies.CONTENT_FILTER = { attempts: 0 }`：**不原地重试**（同一段内容重复发送通常
     仍被拦），直接切下一条来源；切换次数仍受 `maxSwitchesPerTurn` 约束；
   - `cooldownMsFor` 对 `CONTENT_FILTER` 返回 0：拦截是「这次请求的内容」问题、不是路由健康
     问题，不冻结失败路由（`cooldownByCode.CONTENT_FILTER` 仍可显式覆盖）；
   - `failureReasons` 新增 `CONTENT_FILTERED`（「被上游内容安全策略拦截（同来源重试通常无效，
     换来源可再试）」），通知与设置页不再显示「原因未知」；
   - 它与 `policyMode` 是两条路：`policy` 类（提示词被拒）默认同来源原地重试；`content_filter`
     直接换来源。两者都不改写请求内容（见 README「policy 失败为什么不做 prompt 改写」）。

   回归：`node probe/smoke-config.mjs`（期望 ALL PASSED），新增 7 条断言（可切换、生效码、
   attempts=0、冷却 0、原因标签、不误伤 `finish_reason: stop`、模式表包含）。

6. **多 key 当前生效身份（2026-10-29）**：设置页不再只显示引用名和「在用」徽标。
   Host `GET /status` 为每条引用补 `preview`（头尾+中间星号）、`alias`、环境变量则
   `envLevel` + `envId`；条目顶部的 `activeKey` 即使不在轮换列表里也会标成基础 key。
   别名写入 `settings.json` 的 `keyAliasesByEntry`，明文仍不落盘。生效需重启 `dsh web`
   并用新 token 地址重开设置页。

8. **全部可见 key + 手动切换（2026-10-29）**：配置页把当前 `apiKeyEnv` 与轮换列表并排展示；
   已配置的行有「切换到此 key」。Host `POST /keys` 允许切到未写入 `keysByEntry` 的基础 key。
   未保存的新引用仍须先点「保存 key 列表」。生效需重启 `dsh web` 并用新 token 打开设置页。

7. **同路由多模型共用 key（2026-10-29）**：条目可声明 `models`（如 ais 上
   `deepseek-v4.1-flash` 与 `glm-5.3-flash`）。设置页同一行列出；凭据类失败仍按
   路由命中该条目轮换 key，不按模型拆引用。切到本条目时主模型仍是 `model`。

回归：`node probe/smoke-config.mjs`（期望 FAILURES: 0）。
客户端半另有渲染回归：`node probe/client-dock.mjs`（期望 ALL PASSED）——用最小 React
运行时真实渲染 `conversation.input.dock` 的通知条，覆盖「无通知隐形 / 有通知出标题与人话
描述 / 多条可展开 / 取数失败不渲染半截 / 各 kind 不抛错」。它存在的理由：DSH 的 slot
边界会吞掉渲染期异常，只做字符串检查区分不出「没数据」和「渲染崩了」。

**已知缺口（2026-10-19 复核）**：`notices.jsonl` 只有 `appendFileSync`，插件内**没有**
任何回放/读取路径，`noticesOf()` 只查内存表。因此 DSH 重启（或插件重新 apply）后，
历史上的切换通知在页面上不再出现——而 `docs/provider-failover-notice.md` 写的是
「落盘 … 因此环形缓冲轮转后仍可回看」。同理 `status.switches`（设置页「最近转移」）
也是纯内存。要真正「可回看」，需要在 `/notices` 里补一段按 session 过滤、按 `noticeId`
去重、只读文件尾部的回放。
