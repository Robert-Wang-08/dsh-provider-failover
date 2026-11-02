# 3.8.1 请求恢复修复与验收

目标：修复 server_error 识别缺口，使已配置 failover 的会话在同一个失败 step 内有界重试、换路由并继续。

## 根因

2026-11-02 的真实失败日志已经送达 agent/request-error。该步前面的 overloaded 文案被归为 SERVER 并重试，最后文案变为 server_error: An error occurred while processing your request 后，生效码降为 PI_AI_ERROR；插件未命中切换条件，宿主默认也不重试该通用码，故整轮终止。不是插件未启用或事件未送达。

本机诊断快照共 126 条：TRANSPORT 61、SERVER 17、PI_AI_ERROR 25、QUOTA 9、TIMEOUT 8、AUTH 3、CONTEXT_WINDOW_EXCEEDED 2、UNSUPPORTED_REASONING_EFFORT 1。25 条通用错误中 24 条是历史 ais-2dsglm 的 deepseek-v4.1-flash 模型不存在，1 条是本次 server_error。当前设备 route-config 中 ais 主模型为 deepseek-flash；本次未改动设备路由或凭据。此统计是有限日志样本，不能推算完整故障率。原始日志与会话内容不随本报告发布。

## 修复

- server_error/internal_server_error/overloaded_error/service_unavailable 的原始 code 与消息均归 SERVER，运行决策和状态展示共用分类入口。
- overloaded 与通用 server_error 在同一个 step 共用 SERVER 预算，不因文案变化重置；耗尽后进入配置候选链。
- 退避使用可取消计时器，并在进入与返回前检查 AbortSignal。
- 切换次数/间隔护栏移至瞬态重试之后，避免误伤剩余预算。
- 真正选中候选时解除指向失败路由的测试 pin；无候选时不解除。
- 通知日志与失败日志都绑定启动时 DSH_HOME，避免环境变化污染其他实例。

## 验证

新增 [插件恢复回归](probe/smoke-recovery.mjs) 与 [真实宿主集成](probe/host-recovery.mjs)。两者及既有 smoke-config、smoke-cooldown、smoke-keys、smoke-client 共六组命令均 exit 0。真实集成加载本机已安装 DSH 0.2.0-rc.2 的 Cordis、LLM、Session、Tools、Agent 和 AgentLoop 服务，以内存 mock adapter 故障注入；不调用外部模型、不读凭据、不读写生产会话。

真实集成先执行计数工具，再在下一步先返回 overloaded 后返回通用 server_error，验证请求路由依次 a,a,a,b，工具只执行 1 次，用户消息只记录 1 次，turn/end 为 completed。下一轮继续使用 b；全部候选失败为 error，退避中取消为 aborted 且无第二次派发。额外三 Agent 并发测试分别得到 a,a,b，验证真实错误 hook 中 agent 身份由 agentEvents 分发器注入、预算与目标隔离；其中一条在输出工具块后由适配器直接抛出 LlmError，LLM runtime 将其归一化为 finish(error)，仍自动恢复。失败流中的工具调用块从不执行。

独立架构复核提出 pin 优先级与切换守卫阻断，已修复并回归。最终复核关于“错误 payload 缺 agent 导致并发串线”的疑点，经检查 agentEvents 的 fused(payload) 注入与上述真实并发试验排除；不能只从调用点对象字面量推断最终事件载荷。宿主规范流经 LLM runtime 归一化；绕过该 runtime 的自定义 prepared adapter 若直接抛异常，不纳入本次已验证边界。

## 生效与回滚

按 [README](README.md) 在已 link 登记的设备 git pull 后重启原 DSH 服务。无新增依赖、无 profile 改动、无宿主补丁，无需重新 add。已终止的历史轮次需恢复原会话后发送一次继续；新代码只接管之后的请求。回滚对本次提交 git revert 后重启。

运行中进程不会因为磁盘源码更新而自动载入新模块；在原服务重启并完成启动验收前，不宣称生产会话已经获得修复。候选均不可用、ACP 子代理故障和进程崩溃不属于本插件的自动恢复边界。budgetMs 是累计退避预算，不是请求总耗时 SLA；maxSwitchesPerTurn 沿用既有实际按 step 计数的兼容口径。
