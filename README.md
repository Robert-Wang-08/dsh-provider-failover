# dsh-provider-failover

> 包名保持 `dsh-deepseek-keypool`（便于 `dsh plugin` 覆盖安装），能力：**分档 Provider 故障转移 + 单路由多 key（凭据引用轮换）**。

DSH（DeepSeek Harness）的 Host 级常驻插件：当模型请求以**可切换失败**结束时，按配置表的**档位顺序**把同一个 step 的下一次尝试换成另一条 harness 路由（provider），并可一并下发该条目声明的模型与推理层级；条目还可用 `keys` 声明同一条路由的多把 key（**改写该路由的 `apiKeyEnv` 引用名**，不新增路由），并按每日重置时刻恢复默认 key。

## 为什么能生效（已实测）

| 机制 | 证据 |
| --- | --- |
| `agent/request` 是 waterfall，返回值决定本次尝试的 provider/model；同一步的后续尝试会重新发射它 | 本地 mock 探针：`agent/request` 返回新 provider 后，下一次 `llm/stream` 走的就是新路由 |
| `agent/request-error` 每次失败尝试发射一次，返回 `{kind:'retry'}` 触发同一步再试 | 本地 mock 探针：同一步内多次失败各有一条事件 |
| 交回 `next()` 会进入宿主自带重试策略（`dsh-llm-retry`） | 实测 503 在交回后被宿主重试 5 次 |
| 失败码已归一化：402→`QUOTA`、401/403→`AUTH`、429→`RATE_LIMIT`、5xx→`SERVER`；凭据不可用的路由→`NO_ADAPTER` | 本地 mock 端点逐项验证 |

## 可切换失败

默认集合：`QUOTA`、`AUTH`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL`、`NO_ADAPTER`、`SERVER`、`RATE_LIMIT`、`TRANSPORT`。

另有**消息模式兜底**（编码未归一化时按文本匹配）：`insufficient balance`、`insufficient_quota`、`quota exceeded`、`usage limit`、`usage_limit`、`balance`、`overloaded`、`invalid api key`、`token limit`、`rate limit`、`websocket closed`、`websocket error`、`websocket`、`http2`、`upstream_`。

> 兜底的意义：宿主 `classifyPiAiError` **只看错误文案、不看错误对象与 HTTP 状态码**，认不出来就统一返回 `PI_AI_ERROR`；而宿主默认重试码表（`dsh-llm` 的 `retryableCodes`）只含 `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`，**不含 `PI_AI_ERROR`**。所以凡落成 `PI_AI_ERROR` 的失败，宿主既不重试也不切换，唯一恢复路径就是本节这张模式表——漏一条就等于该故障"整轮直接失败"。

同一套兜底也用于**三处展示/判定**，避免同一个错误在不同界面结论不一致：
切换与冷却分类（`patternCodeFor` → `QUOTA`/`TRANSPORT`/…）、全量测试状态标签（`/failover-probe` 与设置页的「全量测试」按钮，不再把未归一化失败一律显示成「未知错误」）、以及按类别重试策略的取类（例如裸 `WebSocket error` 现在正确落到 `TRANSPORT` 的 5 次原地重试，而不是 `DEFAULT` 的 1 次）。

**生效码折算只有一个入口：`effectiveFailureCode(code, message, patterns)`。** 归一化码优先；宿主未归一化时（空码 / `PI_AI_ERROR`）依次做消息模式兜底、HTTP 状态码兜底，都认不出来才返回原码。切换/重试判定（`agent/request-error`）、`isSwitchable`、全量测试展示**全部调用它**——这是刻意的：`PI_AI_ERROR` 不在宿主默认重试码表里，展示与判定一旦分叉，设置页显示的状态就没有意义（会出现「说会切换、实际不动」）。命中方式在通知里可区分：`effective:<CODE>`（折算后落在终止码集合）、`pattern:<模式>`（表外模式，无登记类别时才走到）、`code:<CODE>`（宿主已归一化）。

全量测试还会对**带 HTTP 状态码字样**的未归一化失败兜底：`codex-relay API error (502): 502 status code (no body)` 这类空体 5xx 显示为「服务端/网络异常」而不是「未知错误」。只认已知的 HTTP 错误码表（400/401/402/403/404/408/409/413/422/429/5xx/529），因此 `connect ETIMEDOUT 10.0.0.5:443` 里的 `443` 不会被当成状态码；状态码 → 类别只映射**本插件可切换**的三种（5xx→`SERVER`、401/403→`AUTH`、429→`RATE_LIMIT`），400/404/413/422 等仍保持「请求无效、不切换」。

其中 `usage limit` / `usage_limit` 覆盖 Codex OAuth 常见额度耗尽文案 `The usage limit has been reached` 与 `usage_limit_reached`。部分宿主版本会把前者归成通用 `PI_AI_ERROR`，插件必须依靠消息模式兜底，不能只看 `QUOTA` 编码。

`websocket closed` 覆盖上游 WebSocket/SSE 中途断开（如 `WebSocket closed 1000`）：宿主 `classifyPiAiError` 只把 `WebSocket closed unexpectedly` 归一化为 `TRANSPORT`，仅带关闭码的文案会落到通用 `PI_AI_ERROR`，须靠消息模式兜底才能触发切换。传输层失败按**非凭据类**处理，直接走 provider 切换（换 key 治不了连接断开）。

`http2` / `upstream_` 覆盖网关把上游连接层故障改写成自定义码的情形（实测 2026-10-15：codex-relay 的上游 chatgpt.com Codex 后端 HTTP/2 流被对端复位，relay 以 SSE `error` 事件下发 `{"code":"upstream_http2_stream_error","message":"Upstream HTTP/2 stream failed"}`，pi-ai 拼成 `Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed` 抛出）。该文案既无 5xx 数字也无 `network/socket/connection` 词，宿主两条规则都不命中 → `PI_AI_ERROR` → 修复前**既不重试也不切换**（实测 `isSwitchable` 返回 `hit:false`）。现在折算成 `TRANSPORT`（通知里记 `effective:TRANSPORT`），可吃到「原地重试 5 次 × 5s、预算 30s、观测窗口 30s」，预算耗尽再切换 provider；全量测试里同样显示为「传输中断」。同一条修复也覆盖**任何**留在 `PI_AI_ERROR` 里的 HTTP 失败：空体 502 现在折算 `SERVER`（`effective:SERVER`）并真的触发重试/切换，而不只是状态页好看。
刻意**没有**采用宽泛的 `stream failed`：应用语义的 `stream failed to produce output` 会被误伤（实测仍为「未知错误、不切换」）；`upstream_*` 前缀码已覆盖网关层改写，其余上游文案（`*_timeout`、`*_connection_*`）由 `timeout`/`network`/`connection` 类关键词或 `http2` 承接。

> ⚠️ **这两个键是「整体替换」，不是「追加」。** `terminalCodes` / `failurePatterns` 只要非空，就会**完全替换**上表的默认集合（`index.js` 的 `normalizeConfig`：`strings(input.terminalCodes).length > 0 ? strings(input.terminalCodes) : DEFAULT_TERMINAL_CODES`）。因此在 profile 里一旦列出它们却漏掉 `TRANSPORT`、`SERVER` 或 `websocket closed` / `http2` / `upstream_`，对应故障转移会被**静默关闭**：上游 WebSocket/SSE 中途断开、网关 `upstream_*` 流错误、留在 `PI_AI_ERROR` 里的空体 5xx 都不切换，宿主日志里也不会出现 `switch` 行——看起来像「插件失效」，实际是配置把触发条件删掉了。
>
> **推荐根本不要写这两个键**，直接用默认表（上表即为默认表）。确需自定义时，请以上表为基线**逐项追加**，不要凭记忆重写。

策略拒绝（例如 `Invalid prompt ... flagged as potentially violating our usage policy`）默认按 `policyMode: 'same'` 处理：**保留当前 provider/model**，在同一 `(turn, step)` 内原地重试（不轮换 key、不切换 provider、不给路由冷却），重试次数受 `maxPolicyRetriesPerStep`（默认 2）约束，耗尽后保持当前 provider/model 交回宿主。可用 `policyMode: 'switch'` 恢复旧的「切到下一条已配置 Provider」行为，或用 `'off'` 完全不介入。旧字段 `policyFailover` 仍兼容：未显式给出 `policyMode` 时，`true` → `switch`、`false` → `off`。

`CONTEXT_WINDOW_EXCEEDED` 与 `INVALID_REQUEST` 默认**不**触发（换 provider 不解决问题）。策略拒绝单独由 `policyMode` 控制。

### policy 失败为什么不做 prompt 改写

宿主把每次尝试的请求视为**不可变且可重建**：`dsh-agent-loop` 用 `Object.freeze` 冻结 `GenerateOptions` 与 `messages`，并注册 `llm/stream` 的 request-reconstruction invariant（`JSON.stringify(options.messages) === JSON.stringify(session.deriveMessages())`）；`agent/request` 的契约也明确「cannot mutate messages / 模型可见内容必须走 logged 渠道」。且 `RequestErrorAction` 只支持 `{ kind: 'retry' }`，无法携带改写后的消息。因此**插件不能在重试时改写 prompt**。

代码原因此前评估过两条改写路径，都不可行：

- 在 `llm/stream` waterfall 里 `next(modifiedOptions)` 替换参数——本版 cordis 的 `waterfall` 中 `next` 忽略入参（`next = () => (cbs.shift() ?? inner)(...args)`），参数不会透传；
- 在监听器里就地改写 `options.messages` 后重新 `ctx.llm.stream()`——越过了 loop 的 request-reconstruction invariant，属宿主明确禁止的旁路，脆弱且可能被后续版本判失败。

所以 `policyMode: 'same'` 只保证「不切走、原地再试」，不改请求内容；若上游是硬性策略拦截，重试仍可能失败，最终由 `maxPolicyRetriesPerStep` 收口交回宿主。

## 分档配置表

**默认表是零介入的示例**（示例档禁用、路由不指向真实服务）。实际档位在 profile 的 `cordis.patch.yml` 里覆盖：

| 档位 | 条目 | 路由 | 模型 |
| --- | --- | --- | --- |
| 1 | `example`（**默认禁用**） | `example-provider` | `example-model` |

语义：**先耗尽第一档再进入第二档**；整档耗尽才降级；默认禁用的档位不参与；每个 `(turn, step)` 每把 key 至多尝试一次；单 turn 自动切换次数上限（默认 6）；失败路由进入冷却（默认 60s）；同一 turn 内两次切换的最小间隔默认 1s（`minSwitchIntervalMs: 0` 表示关闭该护栏）。

注意两条容易误解的边界：

- 「每把 key 每步至多一次」是**插件切换语义**的保证，不代表该 provider 只被请求一次：宿主会按 provider 的 `retryPolicy` 在同一步内自行重试（实测每个失败尝试常伴 2 次 `llm/stream`，503 交回宿主后还会再重试若干次）。
- 候选预检失败（路由未注册 / 凭据不可用 / 能力不兼容）会被记录并跳过，日志形如 `candidate skipped (unresolvable): …`；若整张表都不可用，插件不改写请求，直接走宿主原有失败路径。

### 覆盖方式

在 profile 的 `cordis.patch.yml` 里按插件 id 追加 `config`（本仓库也提供 `cordis.patch.yml` 示例）：

```yaml
- id: dsh-deepseek-keypool
  config:
    startup: { preferTier: 1 }          # 启动对齐：0 = 关闭
    ranking: { mode: keywords }          # declared | keywords | llm
    tiers:
      - tier: 1
        enabled: true
        entries:
          - { id: first, route: my-provider, model: my-model, cooldownMs: 60000, reasoningEffort: medium }
      - tier: 2
        enabled: true
        entries:
          - { id: fallback, route: my-provider-2, model: my-model-2, cooldownMs: 60000 }
```

交互式本机配置：使用 `ptc-route-setup` skill 探测 provider/子代理并询问人工偏好。它将无凭据的候选链写入 `$DSH_HOME/plugins/provider-failover/route-config.json`。插件启动时读取该文件，覆盖 `tiers`、切换上限/错误类别和按类冷却策略；现有 `settings.json`、profile patch 和凭据文件保持独立。该本机文件不应提交或同步；首次生成后需重启 DSH。

字段：顶层 `enabled` / `policyMode` / `policyFailover`（兼容旧字段）/ `maxPolicyRetriesPerStep` / `terminalCodes` / `failurePatterns` / `minSwitchIntervalMs` / `maxSwitchesPerTurn` / `cooldownByCode`（按错误码覆盖冷却毫秒，如 `{"QUOTA": 18000000}` 把额度耗尽的冷却拉到 5 小时；usage limit / quota 等消息模式兜底也归 QUOTA，未命中退回条目 `cooldownMs`）/ `probeTarget` / `keyResetAt` / `startup.preferTier` / `ranking` / `tiers`；条目 `id` / `route` / `model` / `keys` / `description` / `keywords` / `compatible.{tools,images}` / `cooldownMs` / `reasoningEffort` / `enabled`。配置**不含任何凭据字段**（`keys` 只写引用名）；校验失败时插件完全不介入并在日志说明原因。

### 冷却语义与「无候选」

- **只在真的切走之后**才给失败路由写冷却：失败但档位表里没有可用候选时，不再顺手冻结这条路。
  否则一串链路抖动会逐个冻住每条路由，等其中某条报额度耗尽时整条梯子都在冷却里，切换无从发生。
- **冷却只延长、不缩短**：同一路由先被判 `QUOTA`（`cooldownByCode.QUOTA`，默认 5 小时）之后，
  再来一条 `SERVER` 不会把它改写成 60 秒，额度已死的路由不会被 60 秒后重新捡回。
- **无候选会留痕**：档位表耗尽时推一条 `kind=exhausted` 的会话通知（进 `notices.jsonl` 与会话
  通知条，附带「谁在冷却」摘要），不再只有内存 `ignored` 环里那条看不见的记录。
- **类别按折算后的生效码**：宿主管线把失败留在 `PI_AI_ERROR` 里、靠消息或状态码折算成 `QUOTA`
  时，冷却同样按 `QUOTA` 计；只有未登记的类别才回退条目 `cooldownMs`。

2026-10-23 的起因与完整时间线（kimi 额度耗尽时五条路由同时冷却 → 无候选）见 DSH 工作区的
`docs/ptc/reports/failover-kimi-quota-20261023.md`；回归断言见 `probe/smoke-cooldown.mjs`。

### 按模型族对齐档位（推荐）

把**同一个 model** 的多个路由放进同一档，额度耗尽时就会先在同族内互备；跨族降级交给下一档：

```yaml
- id: dsh-deepseek-keypool
  config:
    ranking: { mode: declared }        # 固定档内顺序；keywords 会让「先试哪个」随失败上下文漂移
    tiers:
      - tier: 1                        # gpt 族互备
        enabled: true
        entries:
          - { id: relay,    route: codex-relay,  model: gpt-6.1-sol, cooldownMs: 60000 }
          - { id: official, route: openai-codex, model: gpt-6.1-sol, cooldownMs: 120000 }
      - tier: 2                        # deepseek 族互备
        enabled: true
        entries:
          - { id: ais,        route: ais-2dsglm,  model: deepseek-v4.1-flash, cooldownMs: 60000 }
          - { id: opencodego, route: opencode-go, model: deepseek-v4.1-flash, cooldownMs: 60000 }
      - tier: 3                        # 跨族保底
        enabled: true
        entries:
          - { id: kimi, route: kimi-coding, model: k3-256k, cooldownMs: 60000 }
```

**限制（务必先读）**：`pickCandidate` 每次切换都**从第 1 档向上扫**（`for (const tier of config.tiers)`），不是从失败路由所在档开始。因此只要第 1 档还有可用条目，低档的失败就会**升到第 1 档的模型族**——同一时刻**只有一个族**能获得族内互备。上例中 `codex-relay` ↔ `openai-codex` 双向互备成立；但 `ais-2dsglm` 失败会先切到 gpt 族，只有当 gpt 族两路都不可用时，deepseek 才会在同族内互换。若需要两个方向都严格族内互备，须在 `pickCandidate` 增加一个「同 model 优先」的前置 pass（当前版本没有该能力）。

## 单路由多 key（`keys` = 同一路由的凭据引用名）

条目可声明 `keys: [ref1, ref2, …]`（**凭据引用名**，POSIX 标识符；`keys[0]` 是默认 key）启用轮换。**路由与模型不变**——插件不会多出任何 provider，模型选择列表里也不会出现第二条。

机制：宿主 pi-ai 适配器**每次请求**按路由 profile 的 `apiKeyEnv` 解析凭据（`resolveApiKey` → `credentials.resolve(ref)`，profile 按 settings 快照记忆化）。因此插件只需把该路由的 `apiKeyEnv` 从一个引用名改写为另一个，下一次尝试就换了一把 key。

规则：

- **只写引用名，永不写值**：插件经 `ctx.settings.mutate('llm-pi-ai', …)` 改写 `providers.<route>.apiKeyEnv`，不调用凭据服务的任何写接口，也不读取/缓存/打印凭据值。
- **失败分工**：凭据类编码（`QUOTA` / `AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL`）→ 条目内换 key；`SERVER` / `RATE_LIMIT` / `NO_ADAPTER` 与消息模式兜底 → 走 provider 切换（换 key 治不了过载，也不因一句话就消耗一把 key）。
- **候选预检**：轮换前用 `credentials.describe(ref)` 确认目标引用已配置；未配置则跳过并每进程警告一次（`key reference skipped: …`）。全部候选不可用时交回宿主默认失败路径（写入设置文件失败同样如此）。
- **有界**：记账键是 `entryId@route#ref`，同一引用每 `(turn, step)` 至多一次；轮换计入单 turn 上限与最小切换间隔；key 类失败**不给路由冷却**（否则换 key 后仍被冷却挡住）。
- **每个引用只服务一个 provider**：同一引用名不得出现在多个条目（校验拒绝）。
- 无 `keys` 或 `keys: []` 的条目行为与单 key 完全一致。

### 每日重置与手工状态

- 顶层 `keyResetAt`（`HH:MM` 本地时间，默认 `06:00`）：到点清空全部 key 失效标记，并把「当前引用属于 `keys` 且不是首项」的条目写回 `keys[0]`，全部 key 恢复可重试。
- **手工状态优先**：活动引用每次实时读 settings（不缓存，经 `SettingsForms.describe` 读 `llm-pi-ai` 活动表单），你直接改模型路由的 `apiKeyEnv` 立即生效；当前引用**不在** `keys` 内时视为手工状态，重置只清标记、不改写它。
- 手工干预接口：`POST /provider-failover/keys`，body `{entry, ref}` 置位某引用、`{entry}` 重置该条目到 `keys[0]`、`{}` 重置全部（未声明或未配置的引用被拒绝）。设置页也有「重置 key 状态」按钮。

配置示例（profile patch；`keys` 是引用名，不是路由名）：

```yaml
- id: dsh-deepseek-keypool
  config:
    keyResetAt: '06:00'
    tiers:
      - tier: 1
        enabled: true
        entries:
          - { id: first, route: my-provider, model: my-model, keys: [MY_PROVIDER_API_KEY, MY_PROVIDER_API_KEY_2], cooldownMs: 60000 }
```

引用名对应的密钥值由你写入宿主凭据库（`.credentials.yaml` 的 `refs`，或环境变量 / 设置页的 Models 页），插件不代写。实测（本地 mock，未消耗真实额度）：路由 `probe-key-bad` 首把引用在 402 后，未配置的备选被跳过，`apiKeyEnv` 被改写为第二把引用，mock 实收 `Authorization` 从 `sk-probe-ba…` 变为 `sk-probe-go…` 并成功回答，改动经 settings 服务落盘。

## 测试切换（会话级 provider/模型）

不用等真失败，就能验证档位表里的某条目是否可用：

- **对话指令**：`/failover-test`（切到当前条目之后的下一启用条目）、`/failover-test tier:2`、`/failover-test <条目 id>`、`/failover-test clear`（解除）。
- **设置页按钮**：「测试切换」卡片选目标条目后点按钮（未指定时用最近活跃会话），另有「解除测试切换」。

实现要点：

- 切换走**官方会话模型选择通路** `ctx.sessionController.selectModel({sessionId, provider, model, reasoningEffort?})` —— 与模型选择器同一条路，会写 `model/selection` 事件，因此会话选择与 UI 都会变。**副作用**：官方通路会同时把该选择存为默认模型（`agentDefaultModel.saveSelection`），本插件不另造旁路。
- 插件侧同时记一个**会话级 pin**（30 分钟 TTL）：pin 有效期内 `agent/request` 直接下发该目标并**跳过启动对齐**，否则刚切到第二档会被启动对齐拉回第一档。`clear` 或 TTL 到期即解除。
- 测试**不伪造失败**、不注入错误码、不改档位表与 key 引用；真实失败仍按既有逻辑处理。
- 未组合 `sessionController`（或没有活跃会话）时返回明确错误，不静默成功。

## 路由变更通知的口径

- 外部路由变更通知比较的是相邻请求中、本插件覆盖前的 `base.provider/model`，不代表已确认的用户点击，也不代表最终下发配置。
- 故障转移、启动对齐和测试 pin 的目标不写入该观测基线，避免旧 base 在重试时被误报为“手动切回”。测试切换已有独立通知，base 首次跟上当前 pin 时去重一次；之后外部切走再切回仍会通知。
- 自动故障转移仅改写请求配置，不等同于官方持久化选模；模型选择器与通知可能显示不同口径。核查实际请求以宿主 `request/header.config` 为准。

## 启动对齐

默认 `startup.preferTier: 0`（关闭）：**新会话保持宿主默认/最近一次选择，不自动拉回任何档位**；仅在真实可切换失败时才切换。设为 `N>=1` 时：当前路由已属于第 N 档就不改写；不属于时才对齐到该档排序最前的**可用**条目（会跳过不可解析/冷却中/能力不兼容/推理档位不受支持的候选）；目标档不可用时沿档位顺序下探；失败不阻断请求。对齐对每个 Agent 只判定一次，且存在显式选模（pending selection）或已有请求头时永不介入。启动对齐只决定 provider/model，不触碰 key 引用。

## 档内排序

- `declared`：按配置表书写顺序。
- `keywords`（默认）：失败编码/消息与会话所需能力（工具、图片）命中条目关键词或描述者前移。
- `llm`：运行期实时请求一个大模型做排序。排序模型是**有序候选列表** `ranking.models`（默认为空），按序尝试并**跳过正在失败的那条路由**（避免用坏路由去排坏路由）：

  ```yaml
  ranking:
    mode: llm
    timeoutMs: 20000
    cacheTtlMs: 60000
    models:
      - { provider: my-provider-2, model: my-model-2 }
      - { provider: my-provider, model: my-model }
  ```

  也兼容单条写法 `ranking.provider` + `ranking.model`（等价于只有一项的列表）。整条链共用一个 `ranking.timeoutMs` 预算；超时/报错/不可解析一律回退 `keywords`；输入只含失败编码、截断消息与候选 id/描述/关键词，密钥类片段会被抹除。模型回复按**整词**匹配候选 id（`o` 不会命中 `ok`），无法解析时负结果同样入缓存，避免每次失败评估都重发排序请求；插件自身的排序请求会被钩子识别并跳过，不参与路由编排。

  **实测约束（重要）**：

  - 真实排序模型一次排序可达**秒级（5–15s）**，因此 `timeoutMs` 默认 20000ms；若沿用更小值，`llm` 模式实际上每次都会超时回退。
  - 排序是**旁路调用**，不带 agent 循环的会话上下文：依赖会话头或额外凭据的路由可能拒绝旁路调用，因此链里应把**不依赖会话头/额外凭据**的路由放在前面，失败项会被自动跳过并尝试下一项（已实测该回退路径）。
  - 结论：`llm` 排序会让故障转移多等数秒；对延迟敏感时保持默认 `keywords`。

  设置页也能直接选排序模型（provider + model 下拉，目录来自宿主 llm 注册表）：它写用户层覆盖 `rankingModel`，等价于单条 `ranking.provider/model`；清除覆盖后回退 profile 的 `ranking.models` 链。`ranking.mode` 不是 `llm` 时该项不参与排序。

## 凭据策略（重要）

- **插件不持有、不存储、不读取、不写入任何密钥值**；不调用凭据服务的写入接口。
- 凭据由**各路由既有的 `apiKeyEnv`** 从宿主凭据源解析：继承的进程环境（只读、优先）→ `$DSH_HOME/.credentials.yaml`（可写）→ `.env` 兜底。
- 单路由多 key 的唯一写动作是**改写引用名**（`llm-pi-ai.providers.<route>.apiKeyEnv`，经 settings 服务的路径编辑落盘）；轮换前用 `credentials.describe` 确认目标引用已配置，未配置不改写。见上文「单路由多 key」。
- `$DSH_HOME/.credentials.yaml` 含明文密钥，**必须被 `.gitignore` 忽略**。

## 边界与不做什么

- 不修改 dsh 本体、不修改已安装第三方包、不 patch `node_modules`。
- 不做 Provider 实例级卸载/重建，不断言未经验证的能力。
- 不静默改写宿主的默认 provider/model（启动对齐除外，且只按档位口径执行）。
- 客户端半仅做设置页小节（见下文「设置页与状态接口」）：路由决策完全在 Host 半；不提供设置页以外的界面能力。

## 安装与回滚

```powershell
# 从本地目录安装/升级（包名不变）
dsh plugin --profile <profile> add "<本仓库路径>"

# 回滚
dsh plugin --profile <profile> remove dsh-deepseek-keypool
```

安装后需重启 `dsh web` 生效；**客户端半（`client.js`）的改动同样必须重启后才生效**（`/plugins/??dsh-deepseek-keypool/client.js` 按内容哈希 `rev` 供包，旧 `rev` 直接 404）。`dsh web` 每次启动都会打印**带新 token 的地址**（`http://127.0.0.1:3080/?token=…`），重启后旧标签页的 token 已失效——在 UI 上往往表现为「页面或某个插件小节空白」，所以**重启后必须用新打印的地址重开**。

## 上下文溢出与自动恢复（2026-10-16）

`pi-ai detected context overflow for model "..."` 是 pi-ai 对上游上下文超限的标准化文案，最终错误码为 `CONTEXT_WINDOW_EXCEEDED`。它不是 pi-ai 自己“接管了 DSH”，也不是 provider 凭据故障：换 key/provider 无法缩短当前会话历史，所以本插件默认把它记录为 `ignored/context`，不做错误切换。

DSH `compaction-basic` 已支持 `CONTEXT_WINDOW_EXCEEDED -> 压缩 -> 同一步 retry`，但 `dsh 0.2.0-rc.2` 有一个宿主边界缺陷：pi-ai 可能在首个 stream chunk 之前抛出该错误，`dsh-agent-loop` 原先只在流已启动后派发 `agent/request-error`，导致 compaction 根本收不到事件，最终整轮失败。

本机兼容补丁 `D:\src\dsh\dsh-permission-compat\tools\apply-dsh-context-recovery-compat.mjs` 已安装到实际 DSH `0.2.0-rc.2`，标记为 `DSH_SUBMIT_CONTEXT_RECOVERY_COMPAT_V1`，并保留版本化备份。它只把“首个 chunk 前的失败”送入既有 `agent/request-error` waterfall，不修改消息、不伪造错误码、不切换上下文，也不终止当前 DSH；新实例加载后，现有 compaction 会自动压缩并重试。验证入口：

```powershell
node D:\src\dsh\dsh-permission-compat\tools\apply-dsh-context-recovery-compat.mjs --verify
```

“已达到输出 token 上限，回答被截断”是正常的 `max-tokens` 结束态，不等于上下文溢出或 provider 故障。当前版本不对它无限自动续写，以免重复执行工具或在无边界任务上循环；需要续作时应由用户发送“继续”，或后续单独实现有上限、可观测的 continuation policy。



- `[dsh-provider-failover] ready: …` 启动时的档位/条目摘要与 `startup.preferTier`、`ranking` 模式；
- `switch <from> -> <to> tier N (<trigger>)` 每次实际转移（trigger 为 `code:XXX` 或 `pattern:xxx`）；
- `policy retry <n>/<max> on <route> (policy:prompt, turn T step S)` policy 失败时的同 provider 原地重试（耗尽的收口记入 `ignored`，category `policy`）；
- `key rotate <entry>@<route> <旧引用> -> <新引用> (<trigger>)` 条目内换 key（只含引用名，无凭据值）；
- `key reset (scheduled|manual): …` 每日重置/手工重置的动作摘要；
- `candidate skipped (unresolvable): …` / `key reference skipped: <ref> — …` 预检跳过的候选；
- `llm ranking: a > b` 运行期排序结果，或 `llm ranking unavailable, falling back…`。

## 设置页与状态接口

dsh 设置页新增「Provider 故障转移」小节：**总开关** + 常用参数（最小切换间隔、单 turn 上限、启动对齐档位、档内排序模式、key 每日重置时刻），保存后**即时生效，无需重启**；另有「重置 key 状态」按钮，以及两组从宿主目录取值的下拉——**排序模型**（provider + model，写用户层 `rankingModel`）与**默认模型**（provider + model，经宿主 `agentDefaultModel` 服务保存，即新会话起手模型）。

- 持久化：写插件自有文件 `$DSH_HOME/plugins/provider-failover/settings.json`（0.2 起 dsh-settings 移除了按插件命名空间 store 与 `settings.yaml` 用户层）；**用户层优先于 profile patch 的对应字段**（这正是开关语义；没被用户改过的项仍以 patch 为准）。
- 接口（仅本地回环）：
  - `GET /provider-failover/status`：生效值 + 档位表（含每条目 key 引用的 `ref/active/configured/source/failed` 标注）+ `nextKeyResetAt` + 最近 10 条转移/换 key 记录 + 冷却路由。
  - `POST /provider-failover/config`：字段白名单 `{enabled, minSwitchIntervalMs, maxSwitchesPerTurn, startupPreferTier, rankingMode, keyResetAt, rankingModel, defaultModel}`，经 settings 服务落盘。`rankingModel: {provider, model}` 写用户层覆盖，`null` 表示清除覆盖并回退 profile 的 ranking 链；`defaultModel: {provider, model}` 经宿主 `agentDefaultModel` 保存，`null` 表示不改动（宿主默认模型是必填项，没有 clear 接口），宿主服务未装载时该字段返回 503。两者都会先对照实时目录校验，未知 provider/model 返回 400。
  - `GET /provider-failover/catalog`：宿主 provider/model 目录 `{providers:[{id,name,models:[{id,name}],error?}]}`，供设置页下拉使用；单个 provider 取模型失败只标注 `error`，不影响其余目录。
  - `POST /provider-failover/keys`：`{entry, ref}` 手工置位、`{entry}` 重置该条目、`{}` 重置全部（未声明或未配置的引用被拒绝）。
  - `POST /provider-failover/test`：`{entry?, sessionId?, clear?}` 会话级测试切换；状态接口同时返回 `testTargets`、`pins`、`lastSessionId`。
- 档位表与宿主 provider 目录**实时关联**：条目显示 `id → route/model` 并标注「宿主未注册／冷却中」；同时列出未纳入任何档位的 provider 与「档位引用但未注册」的警告。目录不可用（llm 未就绪）时不做关联判断，不误标。
- 客户端半仅注册这一个设置小节；路由决策完全在 Host 半。

## 客户端半的渲染约束（2026-09-23 修复）

设置页小节由 `client.js` 以经典脚本 + `window.__ModuleLoader__.load` 注册。**席位（slot）边界会吞掉渲染期异常**：组件抛错时不会有红色报错页，整个小节就是空白，控制台之外看不到线索。因此客户端半有一条硬约束——**渲染期会被直接读取的绑定，必须在读取点之前完成初始化**（`const`/`let` 的 TDZ 在这里是致命错误，不是风格问题）。

- **已修缺陷**：`testCard` 卡片在构造时就读取 `onClick: runTestSwitch` / `onClick: clearTestSwitch`，而这两个处理函数用 `const` 声明在其后，于是**数据加载完成后的首次完整渲染**抛 `ReferenceError: Cannot access 'runTestSwitch' before initialization`（`ProviderFailoverPanel`）。首屏 `status === null` 会早退渲染「读取中…」，不经过该路径，所以表现为「设置 → Provider 故障转移**整块空白**」，且刷新多少次都一样。
- **修法**：把 `runTestSwitch` / `clearTestSwitch` 前移到 `testCard` 之前，并在该处注释说明顺序是硬约束；界面文案与渲染结构零变化。
- **验证**：
  - 离线渲染桩（Node + React 桩 + 真实 `GET /provider-failover/status` 载荷）：修复前第 1 次完整渲染即抛上述 `ReferenceError`；修复后稳定渲染 8 个子块。
  - 真实宿主（`dsh web`）：打开 设置 → Provider 故障转移，面板完整渲染（标题 / 启用开关 / 最小切换间隔 / 单 turn 上限 / 启动对齐档位 / 档内排序模式 / key 列表 / 档位表），控制台无 `exception`。
- **生效条件**：客户端半改动必须重启 `dsh web`，并用启动时打印的新 token 地址重开页面（见「安装与回滚」）。

## 开发

```powershell
pnpm install
node --check index.js
node probe/smoke-config.mjs      # 配置归一化、key 轮换与接口冒烟（不依赖 dsh 运行时）
node probe/mock-llm.mjs 8799     # 本地 mock LLM 端点（配合 probe/dsh-failover-probe 做运行时验证）
```

`probe/` 内全部凭据均为假值，不依赖任何真实服务。

## 宿主兼容性（2026-09-23 复查：dsh 0.1.5-rc.3 + dsh-permission-compat）

宿主升级 `0.1.5-rc.2 → rc.3`（npm latest）并打上全局 `dsh-permission-compat` 沙箱补丁（改 `dsh-sandbox` + 三个工具守卫）后复查，**本插件零改动可用**：

- 与补丁无关：源码不引用 `sandbox_permissions` / `justification` / `approveEscalation` / `WIDER_MODES` 等提权 API（grep 零命中）。补丁只把「冗余提权声明」这一类原本会抛错的调用归一化，**不改写任何 LLM 失败码与错误文案**，`QUOTA`/`AUTH`/`RATE_LIMIT`/`SERVER` 归一化判定与消息模式兜底不受影响；本插件观察的是 `agent/request-error`（LLM 层），不是工具结果层。
- 与 rc.3 无关：`agent/request`（`dsh-agent`、`dsh-agent-loop`）与 `agent/request-error`（`dsh-agent-loop`、`dsh-llm-retry`）在 rc.3 内核逐字存在；`dsh-agent-loop` / `dsh-agent` / `dsh-llm-retry` 的 rc.2↔rc.3 发布包仅 package.json 版本号差异，waterfall 语义未变。

复查记录见 vault `70-WorkSpace/dsh工具维护日志.md` 2026-09-23 条目；复装说明见 `70-WorkSpace/dsh复装说明.md`。

## 缺陷修复：长会话超过 128 步后切换不生效（2026-10-06）

**现象**：`agent/request-error` 已记录 `switch <from> -> <to>`（例如 Codex 额度耗尽 `PI_AI_ERROR` / `pattern:usage limit`），但同一 `(turn, step)` 的下一次请求仍走原 provider，整轮最终仍以原错误失败；且同一 `(turn, step)` 的切换次数远超 `maxSwitchesPerTurn`。

**根因**：`stepState` 为新的 `(turn, step)` 建记账时先用 `at: 0` 入表，随后在同一函数内做容量淘汰（`state.steps.size > 128`）。淘汰扫描取最小 `at`，而刚插入的记账 `at` 恰为 0，于是**它总是被自己这一轮淘汰删除**。一旦会话累计步数超过 128（长会话很常见；实测 turn 30 已 480+ 步），每个新记账都建后即删——`request-error` 写入的 `target` 落在被删除的对象上，`request` 再次取到的是一条全新空记账，因此切换只记日志、不生效；`switches` 计数同样每次归零，`maxSwitchesPerTurn` 形同失效。

**修法**：新建记账直接写 `at: Date.now()`，并在淘汰扫描中排除当前 key（`if (k === key) continue`），确保活跃记账不会被同毫秒并列误删。

**回归**：`probe/smoke-config.mjs` 新增「先跑满 200 个 step 再触发 usage-limit 切换」用例——修复前切换不作用于下一步请求（收到 `r1`），修复后作用于 `r2`。

**生效条件**：`index.js` 为 Host 半代码，改动**必须重启 `dsh web`**（重启后用启动打印的新 token 地址重开页面）。

**同类排查（2026-10-06）**：全量审计有界集合后，`steps` 之外另修两处——

- `status` 的 `switches`/`ignored` 用 `slice(-LOG_LIMIT)` 取到的是**最旧** 10 条（`switchLog` 为 `unshift` 的 newest-first），超过 10 条后设置页展示陈旧记录；改为 `slice(0, LOG_LIMIT)`。
- `pendingNeeds` 淘汰与 `steps` 同形，因入表时已写 `at: Date.now()` 故未触发，但仍补上排除当前 key（`if (k === needsKey) continue`）以固化不变量。

其余有界集合无此问题：`switchLog`/`ignoredLog` 的 50 条上限方向正确；`rankingCache` 按插入序 FIFO 淘汰（新键追加在尾，不会被自身淘汰，`at` 仅用于 TTL）；`startupHandled` 为 `WeakSet` 不阻止 GC；`lastSwitchAt`/`pins` 随会话增长但非淘汰逻辑缺陷。
