# dsh-provider-failover

> 包名保持 `dsh-deepseek-keypool`（便于 `dsh plugin` 覆盖安装），能力：**分档 Provider 故障转移 + 条目内 key 轮换**。

DSH（DeepSeek Harness）的 Host 级常驻插件：当模型请求以**可切换失败**结束时，按配置表的**档位顺序**把同一个 step 的下一次尝试换成另一条 harness 路由（provider），并可一并下发该条目声明的模型与推理层级；条目还可声明多把 key（兄弟路由别名）实现**条目内 key 轮换**。

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

字段：顶层 `enabled` / `terminalCodes` / `failurePatterns` / `minSwitchIntervalMs` / `maxSwitchesPerTurn` / `probeTarget` / `startup.preferTier` / `ranking` / `tiers`；条目 `id` / `route` / `model` / `keys` / `description` / `keywords` / `compatible.{tools,images}` / `cooldownMs` / `reasoningEffort` / `enabled`。配置**不含任何凭据字段**；校验失败时插件完全不介入并在日志说明原因。

## 条目内 key 轮换（opt-in）

条目可声明 `keys: string[]`（**兄弟路由 key**，非凭据值），启用「单个 provider 多把 key」的 key 池：失败时先在条目内换下一把 key，条目内耗尽再换条目/降档。

- 每把 key 每 `(turn, step)` 至多尝试一次，计入单 turn 切换上限与最小切换间隔；失败 key 按条目 `cooldownMs` 冷却（自动关闭、到期恢复），也可随时从 `keys[]` 移除。
- 未注册/不可解析的 key 候选被预检跳过并警告（每进程每路由一次，日志形如 `key candidate skipped (unresolvable): …`）。
- `switchLog` 与 status 接口带 key 维度（只记路由别名，无任何凭据值）。
- **每个 key 只用于单个 provider**：同一路由 key 不得出现在多个条目的 `route`/`keys`（校验拒绝）；两条路由不得指向同一凭据引用。
- **oauth / 非 key-api 凭据的 provider 默认不可用**：不支持 `keys[]`，插件也不会为其创建或桥接凭据。
- 凭据纪律不变：插件不 resolve、不缓存、不写任何 key 值；每把 key 的解析由适配器按该路由自身 `apiKeyEnv` 完成（环境 → `.credentials.yaml` → `.env`）。

配置示例（profile patch；条目内轮换序列 = `my-provider` → `my-provider-k2`）：

```yaml
- id: dsh-deepseek-keypool
  config:
    tiers:
      - tier: 1
        enabled: true
        entries:
          - { id: first, route: my-provider, model: my-model, keys: [my-provider-k2], cooldownMs: 60000 }
```

settings.yaml 侧为每把额外 key 建一条**同 baseURL** 的兄弟路由（名称以实际为准）：

```yaml
llm-pi-ai:
  providers:
    my-provider-k2:
      displayName: my-provider-k2
      apiKeyEnv: MY_PROVIDER_API_KEY_2   # 第二把 key 的凭据引用（由 dsh 自身机制落盘）
      api: openai-completions
      baseURL: http://<与 my-provider 相同>/v1
      models:                            # 与主路由声明一致
        - id: my-model
```

实测（本地 mock，未消耗真实额度）：同 baseURL 两把 key 一坏一好，坏 key 402 后条目内换 key，线上请求的 Authorization 从坏 key 变为好 key 并成功回答；不可解析 key 候选被跳过并警告；`.credentials.yaml` 全程零写入。

## 启动对齐

`startup.preferTier: 1` 表示：**当前路由已属于第一档就不改写**；不属于时才对齐到该档排序最前的可用条目；目标档不可用时沿档位顺序下探；失败不阻断请求。设为 `0` 则完全跟随宿主默认路由。启动对齐只落条目主路由（`keys` 仅参与失败路径）。

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

- **插件不持有、不存储、不写入任何密钥**；不调用凭据服务的写入接口。
- 凭据由**各路由既有的 `apiKeyEnv`** 从宿主凭据源解析：继承的进程环境（只读、优先）→ `$DSH_HOME/.credentials.yaml`（可写）→ `.env` 兜底。
- 条目内 key 轮换同样零写入：每把 key 都是独立路由的 `apiKeyEnv` 引用，见上文「条目内 key 轮换」。
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
- `switch <from> -> <to> tier N [key <alias>] (<trigger>)` 每次实际转移（trigger 为 `code:XXX` 或 `pattern:xxx`；条目内换 key 时带 `key` 维度）；
- `candidate skipped (unresolvable): …` / `key candidate skipped (unresolvable): …` 预检跳过的候选；
- `llm ranking: a > b` 运行期排序结果，或 `llm ranking unavailable, falling back…`。

## 设置页与状态接口

dsh 设置页新增「Provider 故障转移」小节：**总开关** + 常用参数（最小切换间隔、单 turn 上限、启动对齐档位、档内排序模式），保存后**即时生效，无需重启**。

- 持久化：写宿主 settings 命名空间 `provider-failover`，用户层落 `$DSH_HOME/settings.yaml` 的 `provider-failover:` 段；**用户层优先于 profile patch 的对应字段**（这正是开关语义；没被用户改过的项仍以 patch 为准）。
- 接口（仅本地回环）：
  - `GET /provider-failover/status`：生效值 + 档位表（含每条目 `keys` 候选的注册/冷却标注）+ 最近转移（10 条）+ 冷却路由。
  - `POST /provider-failover/config`：字段白名单 `{enabled, minSwitchIntervalMs, maxSwitchesPerTurn, startupPreferTier, rankingMode}`，经 settings 服务落盘。
- 档位表与宿主 provider 目录**实时关联**：条目显示 `id → route/model` 并标注「宿主未注册／冷却中」；同时列出未纳入任何档位的 provider 与「档位引用但未注册」的警告。目录不可用（llm 未就绪）时不做关联判断，不误标。
- 客户端半仅注册这一个设置小节；路由决策完全在 Host 半。

## 开发

```powershell
pnpm install
node --check index.js
node probe/smoke-config.mjs      # 配置归一化与导出形状冒烟（48 项断言）
node probe/mock-llm.mjs 8799     # 本地 mock LLM 端点（配合 probe/dsh-failover-probe 做运行时验证）
```

`probe/` 内全部凭据均为假值，不依赖任何真实服务。
