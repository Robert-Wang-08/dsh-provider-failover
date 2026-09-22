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

默认集合：`QUOTA`、`AUTH`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL`、`NO_ADAPTER`、`SERVER`、`RATE_LIMIT`。

另有**消息模式兜底**（编码未归一化时按文本匹配）：`insufficient balance`、`insufficient_quota`、`quota exceeded`、`balance`、`overloaded`、`invalid api key`、`token limit`、`rate limit`。

`CONTEXT_WINDOW_EXCEEDED` 与 `INVALID_REQUEST` 默认**不**触发（换 provider 不解决问题）。

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

字段：顶层 `enabled` / `terminalCodes` / `failurePatterns` / `minSwitchIntervalMs` / `maxSwitchesPerTurn` / `probeTarget` / `keyResetAt` / `startup.preferTier` / `ranking` / `tiers`；条目 `id` / `route` / `model` / `keys` / `description` / `keywords` / `compatible.{tools,images}` / `cooldownMs` / `reasoningEffort` / `enabled`。配置**不含任何凭据字段**（`keys` 只写引用名）；校验失败时插件完全不介入并在日志说明原因。

## 单路由多 key（`keys` = 同一路由的凭据引用名）

条目可声明 `keys: [ref1, ref2, …]`（**凭据引用名**，POSIX 标识符；`keys[0]` 是默认 key）启用轮换。**路由与模型不变**——插件不会多出任何 provider，模型选择列表里也不会出现第二条。

机制：宿主 pi-ai 适配器**每次请求**按路由 profile 的 `apiKeyEnv` 解析凭据（`resolveApiKey` → `credentials.resolve(ref)`，profile 按 settings 快照记忆化）。因此插件只需把该路由的 `apiKeyEnv` 从一个引用名改写为另一个，下一次尝试就换了一把 key。

规则：

- **只写引用名，永不写值**：插件经 `ctx.settings.mutate('llm-pi-ai', …)` 改写 `providers.<route>.apiKeyEnv`，不调用凭据服务的任何写接口，也不读取/缓存/打印凭据值。
- **失败分工**：凭据类编码（`QUOTA` / `AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL`）→ 条目内换 key；`SERVER` / `RATE_LIMIT` / `NO_ADAPTER` 与消息模式兜底 → 走 provider 切换（换 key 治不了过载，也不因一句话就消耗一把 key）。
- **候选预检**：轮换前用 `credentials.describe(ref)` 确认目标引用已配置；未配置则跳过并每进程警告一次（`key reference skipped: …`）。全部候选不可用时交回宿主默认失败路径（`settings` 只读、命名空间未注册、写入抛错同样如此）。
- **有界**：记账键是 `entryId@route#ref`，同一引用每 `(turn, step)` 至多一次；轮换计入单 turn 上限与最小切换间隔；key 类失败**不给路由冷却**（否则换 key 后仍被冷却挡住）。
- **每个引用只服务一个 provider**：同一引用名不得出现在多个条目（校验拒绝）。
- 无 `keys` 或 `keys: []` 的条目行为与单 key 完全一致。

### 每日重置与手工状态

- 顶层 `keyResetAt`（`HH:MM` 本地时间，默认 `06:00`）：到点清空全部 key 失效标记，并把「当前引用属于 `keys` 且不是首项」的条目写回 `keys[0]`，全部 key 恢复可重试。
- **手工状态优先**：活动引用每次实时读 settings（不缓存），你直接改 `settings.yaml` 的 `apiKeyEnv` 立即生效；当前引用**不在** `keys` 内时视为手工状态，重置只清标记、不改写它。
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

引用名对应的密钥值由你写入宿主凭据库（`.credentials.yaml` 的 `refs`，或环境变量 / 设置页的 Models 页），插件不代写。实测（本地 mock，未消耗真实额度）：路由 `probe-key-bad` 首把引用在 402 后，未配置的备选被跳过，`apiKeyEnv` 被改写为第二把引用，mock 实收 `Authorization` 从 `sk-probe-ba…` 变为 `sk-probe-go…` 并成功回答，`settings.yaml` 同步落盘。

## 启动对齐

`startup.preferTier: 1` 表示：**当前路由已属于第一档就不改写**；不属于时才对齐到该档排序最前的可用条目；目标档不可用时沿档位顺序下探；失败不阻断请求。设为 `0` 则完全跟随宿主默认路由。启动对齐只决定 provider/model，不触碰 key 引用。

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

安装后需重启 `dsh web` 生效。

## 诊断

宿主日志中可见：

- `[dsh-provider-failover] ready: …` 启动时的档位/条目摘要与 `startup.preferTier`、`ranking` 模式；
- `switch <from> -> <to> tier N (<trigger>)` 每次实际转移（trigger 为 `code:XXX` 或 `pattern:xxx`）；
- `key rotate <entry>@<route> <旧引用> -> <新引用> (<trigger>)` 条目内换 key（只含引用名，无凭据值）；
- `key reset (scheduled|manual): …` 每日重置/手工重置的动作摘要；
- `candidate skipped (unresolvable): …` / `key reference skipped: <ref> — …` 预检跳过的候选；
- `llm ranking: a > b` 运行期排序结果，或 `llm ranking unavailable, falling back…`。

## 设置页与状态接口

dsh 设置页新增「Provider 故障转移」小节：**总开关** + 常用参数（最小切换间隔、单 turn 上限、启动对齐档位、档内排序模式、key 每日重置时刻），保存后**即时生效，无需重启**；另有「重置 key 状态」按钮。

- 持久化：写宿主 settings 命名空间 `provider-failover`，用户层落 `$DSH_HOME/settings.yaml` 的 `provider-failover:` 段；**用户层优先于 profile patch 的对应字段**（这正是开关语义；没被用户改过的项仍以 patch 为准）。
- 接口（仅本地回环）：
  - `GET /provider-failover/status`：生效值 + 档位表（含每条目 key 引用的 `ref/active/configured/source/failed` 标注）+ `nextKeyResetAt` + 最近 10 条转移/换 key 记录 + 冷却路由。
  - `POST /provider-failover/config`：字段白名单 `{enabled, minSwitchIntervalMs, maxSwitchesPerTurn, startupPreferTier, rankingMode, keyResetAt}`，经 settings 服务落盘。
  - `POST /provider-failover/keys`：`{entry, ref}` 手工置位、`{entry}` 重置该条目、`{}` 重置全部（未声明或未配置的引用被拒绝）。
- 档位表与宿主 provider 目录**实时关联**：条目显示 `id → route/model` 并标注「宿主未注册／冷却中」；同时列出未纳入任何档位的 provider 与「档位引用但未注册」的警告。目录不可用（llm 未就绪）时不做关联判断，不误标。
- 客户端半仅注册这一个设置小节；路由决策完全在 Host 半。

## 开发

```powershell
pnpm install
node --check index.js
node probe/smoke-config.mjs      # 配置归一化、key 轮换与接口冒烟（不依赖 dsh 运行时）
node probe/mock-llm.mjs 8799     # 本地 mock LLM 端点（配合 probe/dsh-failover-probe 做运行时验证）
```

`probe/` 内全部凭据均为假值，不依赖任何真实服务。
