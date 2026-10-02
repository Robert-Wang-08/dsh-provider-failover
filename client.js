/**
 * dsh-deepseek-keypool — 客户端半（client.js）
 *
 * 在 dsh 设置页注册「Provider 故障转移」小节：总开关 + 常用参数，保存后写
 * settings 命名空间 `provider-failover`（用户层 = `$DSH_HOME/settings.yaml`），
 * Host 半 watch 到变更即时生效（无需重启）。
 *
 * 读写经同源接口：
 *   GET  /provider-failover/status  → 当前生效值 + 档位表 + 最近转移 + 冷却
 *   POST /provider-failover/config  → { enabled?, minSwitchIntervalMs?, ... }
 *
 * 本文件不包含任何凭据，也不接触密钥。
 */
window.__ModuleLoader__.load({
  id: "dsh-deepseek-keypool",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");

    const ROUTE = "/provider-failover";
    const h = react.createElement;

    const RANKING_MODES = [
      { value: "declared", label: "declared（按配置表顺序）" },
      { value: "keywords", label: "keywords（关键词命中前移）" },
      { value: "llm", label: "llm（运行期大模型排序，较慢）" },
    ];

    const CSS = [
      ".pf-root{display:flex;flex-direction:column;gap:14px;padding:2px 2px 32px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}",
      ".pf-title{font-size:15px;font-weight:600}",
      ".pf-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}",
      ".pf-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}",
      ".pf-row{display:flex;align-items:center;justify-content:space-between;gap:12px}",
      ".pf-row>label{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}",
      ".pf-row>input[type=number],.pf-row>input[type=text],.pf-row>select{width:168px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
      ".pf-hint{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".pf-warn{color:var(--dsw-alias-state-error-primary);font-size:12px}",
      ".pf-keyrow{display:flex;align-items:center;gap:8px}",
      ".pf-keyrow>input{flex:1 1 auto;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono,monospace);font-size:12px}",
      ".pf-badge{flex:0 0 auto;font-size:12px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1)}",
      ".pf-badge-active{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
      ".pf-badge-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
      ".pf-badge-failed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".pf-badge-muted{color:var(--dsw-alias-label-secondary)}",
      ".pf-entry{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;display:flex;flex-direction:column;gap:6px}",
      ".pf-entry:first-of-type{border-top:0;padding-top:0}",
      ".pf-actions{display:flex;align-items:center;gap:10px}",
      ".pf-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}",
      ".pf-btn[disabled]{opacity:.5;cursor:default}",
      ".pf-ok{color:var(--dsw-alias-state-success-primary)}",
      ".pf-err{color:var(--dsw-alias-state-error-primary)}",
      ".pf-mono{font-family:var(--dsw-font-mono,monospace);font-size:12px}",
      ".pf-list{margin:0;padding-left:18px}",
    ].join("");

    async function apiFetch(url, options, timeoutMs) {
      const response = await fetch(url, Object.assign({}, options, { signal: AbortSignal.timeout(timeoutMs === undefined ? 15000 : timeoutMs) }));
      let data = null;
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
      if (response.ok !== true) {
        const message = data !== null && typeof data.error === "string" ? data.error : url + " -> " + String(response.status);
        throw new Error(message);
      }
      return data;
    }

    const getStatus = () => apiFetch(ROUTE + "/status");
    const saveConfig = (patch) =>
      apiFetch(ROUTE + "/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
    const testSwitch = (body) =>
      apiFetch(ROUTE + "/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const resetKeys = (body) =>
      apiFetch(ROUTE + "/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body === undefined ? {} : body),
      });
    // 全量测试是顺序真实请求，可能耗时较久（每目标最长 20s），因此放宽客户端超时到 10 分钟。
    const probeAll = (body) =>
      apiFetch(ROUTE + "/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body === undefined ? {} : body),
      }, 600000);

    function describeSwitch(entry) {
      if (entry === null || entry === undefined) return "";
      if (entry.kind === "startup-align") {
        return "启动对齐 " + String(entry.from) + " → " + String(entry.to) + "（档 " + String(entry.tier) + "）";
      }
      return String(entry.from) + " → " + String(entry.to) + "（档 " + String(entry.tier) + "，" + String(entry.code) + "）";
    }

    /** 未切换原因的分类中文标签（对应 Host 半 isSwitchable 的 category）。 */
    const IGNORED_LABELS = {
      policy: "策略拒绝",
      context: "上下文超限",
      "invalid-request": "请求无效",
      configuration: "推理档位不兼容",
      other: "其他",
    };
    function ignoredLabel(category) {
      return IGNORED_LABELS[category] === undefined ? "其他" : IGNORED_LABELS[category];
    }
    function describeIgnored(item) {
      const when = item.at === undefined ? "" : new Date(item.at).toLocaleTimeString();
      const where = String(item.provider) + " · turn " + String(item.turn) + "/step " + String(item.step);
      const code = item.code === undefined || String(item.code).length === 0 ? "" : " · " + String(item.code);
      const why = item.reason !== undefined && String(item.reason).length > 0 ? String(item.reason) : String(item.message === undefined ? "" : item.message);
      return "[" + ignoredLabel(item.category) + "] " + where + code + " · " + why + "（" + when + "）";
    }

    function ProviderFailoverPanel() {
      const [status, setStatus] = react.useState(null);
      const [form, setForm] = react.useState(null);
      const [keyDraft, setKeyDraft] = react.useState(null);
      const [testTarget, setTestTarget] = react.useState("");
      const [testMsg, setTestMsg] = react.useState("");
      const [testMsgKind, setTestMsgKind] = react.useState("ok");
      const [error, setError] = react.useState("");
      const [keyError, setKeyError] = react.useState("");
      const [saved, setSaved] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [probeReport, setProbeReport] = react.useState(null);
      const [probeMsg, setProbeMsg] = react.useState("");
      const [probeMsgKind, setProbeMsgKind] = react.useState("ok");
      const [probeBusy, setProbeBusy] = react.useState(false);

      /** 由状态快照构造 key 草稿：条目 id → 引用名数组（生效值，含 patch 回退）。 */
      const draftOf = (data) => {
        const draft = {};
        for (const tier of data.tiers) {
          for (const entry of tier.entries) {
            const declared = data.editable.keysByEntry === undefined ? undefined : data.editable.keysByEntry[entry.id];
            draft[entry.id] = Array.isArray(declared) ? declared.slice() : entry.keys.map((item) => item.ref);
          }
        }
        return draft;
      };

      const load = react.useCallback(async () => {
        try {
          const data = await getStatus();
          setStatus(data);
          setForm(data.editable);
          setKeyDraft(draftOf(data));
          if (data.lastProbe !== undefined && data.lastProbe !== null) setProbeReport(data.lastProbe);
          setError("");
        } catch (err) {
          setError(err.message);
        }
      }, []);

      react.useEffect(() => {
        load();
      }, [load]);

      if (error.length > 0 && status === null) {
        return h("div", { className: "pf-root" }, h("div", { className: "pf-err" }, "无法读取状态：" + error));
      }
      if (status === null || form === null || keyDraft === null) {
        return h("div", { className: "pf-root" }, h("div", { className: "pf-sub" }, "读取中…"));
      }

      const set = (key) => (event) => {
        const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
        setForm((prev) => Object.assign({}, prev, { [key]: value }));
        setSaved("");
      };

      const patch = {};
      if (form.enabled !== status.editable.enabled) patch.enabled = form.enabled === true;
      if (String(form.minSwitchIntervalMs) !== String(status.editable.minSwitchIntervalMs)) patch.minSwitchIntervalMs = Number(form.minSwitchIntervalMs);
      if (String(form.maxSwitchesPerTurn) !== String(status.editable.maxSwitchesPerTurn)) patch.maxSwitchesPerTurn = Number(form.maxSwitchesPerTurn);
      if (String(form.startupPreferTier) !== String(status.editable.startupPreferTier)) patch.startupPreferTier = Number(form.startupPreferTier);
      if (form.rankingMode !== status.editable.rankingMode) patch.rankingMode = form.rankingMode;
      if (String(form.keyResetAt) !== String(status.editable.keyResetAt)) patch.keyResetAt = String(form.keyResetAt);
      const dirty = Object.keys(patch).length > 0;

      const save = async () => {
        if (dirty !== true) return;
        setBusy(true);
        try {
          const data = await saveConfig(patch);
          setStatus(data);
          setForm(data.editable);
          setKeyDraft(draftOf(data));
          setError("");
          setSaved("已保存并即时生效");
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };

      /** key 草稿编辑：改名 / 增行 / 删行。 */
      const setKeyRef = (entryId, index, value) =>
        setKeyDraft((prev) => Object.assign({}, prev, { [entryId]: prev[entryId].map((ref, at) => at === index ? value : ref) }));
      const addKeyRef = (entryId) =>
        setKeyDraft((prev) => Object.assign({}, prev, { [entryId]: prev[entryId].concat([""]) }));
      const removeKeyRef = (entryId, index) =>
        setKeyDraft((prev) => Object.assign({}, prev, { [entryId]: prev[entryId].filter((ref, at) => at !== index) }));

      /** 提交：只保留有内容的引用；某条目全部清空 = 删除该覆盖，回退 profile patch。 */
      const saveKeys = async () => {
        const map = {};
        for (const entryId of Object.keys(keyDraft)) {
          const refs = keyDraft[entryId].map((ref) => String(ref).trim()).filter((ref) => ref.length > 0);
          if (refs.length > 0) map[entryId] = refs;
        }
        setBusy(true);
        try {
          const data = await saveConfig({ keysByEntry: map });
          setStatus(data);
          setForm(data.editable);
          setKeyDraft(draftOf(data));
          setKeyError("");
          setSaved("key 列表已保存并即时生效");
        } catch (err) {
          setKeyError(err.message);
        } finally {
          setBusy(false);
        }
      };

      /** 某引用在当前快照里的状态徽标（只用快照里的字段，界面不接触密钥值）。 */
      const refBadge = (entry, ref) => {
        const item = entry.keys.find((key) => key.ref === ref);
        if (item === undefined) {
          return h("span", { className: "pf-badge pf-badge-muted" }, "未保存");
        }
        if (item.failed === true) {
          const when = item.failedAt === undefined ? "" : new Date(item.failedAt).toLocaleTimeString();
          const why = [item.failedCode, item.failedMessage].filter((part) => part !== undefined && String(part).length > 0).join(" · ");
          return h("span", { className: "pf-badge pf-badge-failed", title: why }, "失效 " + when + (why.length > 0 ? " · " + why : ""));
        }
        if (item.configured !== true) {
          return h("span", { className: "pf-badge pf-badge-muted", title: "宿主凭据库中没有这个引用" }, "未配置");
        }
        return h("span", { className: "pf-badge " + (item.active === true ? "pf-badge-active" : "pf-badge-muted") },
          item.active === true ? "在用" : "可用",
          item.source === "env" ? " · 环境" : "");
      };

      const keyCard = h("div", { className: "pf-card" },
        h("div", { className: "pf-hint" }, "单 provider 多 key（凭据引用名）——填环境变量名，不要填密钥值；值请在 .credentials.yaml 或环境变量里提供。列表顺序即轮换顺序，首项为默认 key。"),
        status.tiers.map((tier) => tier.entries.map((entry) =>
          h("div", { className: "pf-entry", key: entry.id },
            h("div", { className: "pf-row" },
              h("label", null, String(entry.id) + " → " + String(entry.route) + "/" + String(entry.model)),
              h("span", { className: "pf-hint" }, entry.keysSource === "settings" ? "来源：设置" : "来源：profile patch")),
            keyDraft[entry.id].map((ref, index) =>
              h("div", { className: "pf-keyrow", key: entry.id + "-" + String(index) },
                h("input", {
                  type: "text",
                  value: ref,
                  placeholder: "MY_PROVIDER_API_KEY_2",
                  onChange: (event) => { setKeyRef(entry.id, index, event.target.value); setSaved(""); setKeyError(""); },
                }),
                refBadge(entry, String(ref).trim()),
                h("button", { className: "pf-btn", disabled: busy === true, onClick: () => removeKeyRef(entry.id, index) }, "移除"))),
            h("div", { className: "pf-actions" },
              h("button", { className: "pf-btn", disabled: busy === true, onClick: () => addKeyRef(entry.id) }, "+ 添加 key 引用"),
              h("span", { className: "pf-hint" }, keyDraft[entry.id].length === 0 ? "（无 key 引用：该条目不参与轮换）" : ""))))),
        h("div", { className: "pf-actions" },
          h("button", { className: "pf-btn", disabled: busy === true, onClick: saveKeys }, busy === true ? "保存中…" : "保存 key 列表"),
          h("span", { className: "pf-hint" }, "清空某条目的全部引用 = 删除该覆盖，回退 profile patch 的 keys"),
          keyError.length > 0 ? h("span", { className: "pf-err" }, keyError) : null));

      /** 测试切换：切到目标条目（空 = 下一个启用条目），并展示结果。 */
      const runTestSwitch = async () => {
        setBusy(true);
        try {
          const data = await testSwitch(testTarget.length > 0 ? { entry: testTarget } : {});
          setStatus(data.status);
          setForm(data.status.editable);
          setTestMsgKind("ok");
          setTestMsg("已切换：" + String(data.pin.route) + "/" + String(data.pin.model) + "（会话 " + String(data.sessionId) + "）");
        } catch (err) {
          setTestMsgKind("error");
          setTestMsg(err.message);
        } finally {
          setBusy(false);
        }
      };

      /** 解除本插件设置的会话级测试 pin。 */
      const clearTestSwitch = async () => {
        setBusy(true);
        try {
          const data = await testSwitch({ clear: true });
          setStatus(data.status);
          setTestMsgKind("ok");
          setTestMsg("已解除测试切换");
        } catch (err) {
          setTestMsgKind("error");
          setTestMsg(err.message);
        } finally {
          setBusy(false);
        }
      };

      /**
       * 测试切换卡片。必须定义在 `runTestSwitch` / `clearTestSwitch` 之后：
       * 本对象在渲染期就被构造，`onClick: runTestSwitch` 会立刻读取该绑定，
       * 若两个处理函数仍在 TDZ 中，整个面板渲染会抛
       * `Cannot access 'runTestSwitch' before initialization`，该设置小节
       * 因而整体空白（首屏「读取中…」不触发，故不易察觉）。
       */
      const testCard = h("div", { className: "pf-card" },
        h("div", { className: "pf-hint" }, "测试切换（会话级）——把当前会话所选 provider/模型切到指定条目，验证档位是否可用；也可在对话窗输入 /failover-test [tier:N|条目 id|clear]。"),
        h("div", { className: "pf-row" },
          h("label", { htmlFor: "pf-test-target" }, "目标条目"),
          h("select", { id: "pf-test-target", value: testTarget, onChange: (event) => { setTestTarget(event.target.value); setTestMsg(""); } },
            h("option", { value: "" }, "（下一个启用条目）"),
            (status.testTargets === undefined ? [] : status.testTargets).map((item) =>
              h("option", { key: item.id, value: item.id }, String(item.id) + " → " + String(item.route) + "/" + String(item.model) + "（档 " + String(item.tier) + "）")))),
        h("div", { className: "pf-actions" },
          h("button", { className: "pf-btn", disabled: busy === true, onClick: runTestSwitch }, busy === true ? "切换中…" : "测试切换"),
          h("button", { className: "pf-btn", disabled: busy === true, onClick: clearTestSwitch }, "解除测试切换"),
          status.pins === undefined || status.pins.length === 0
            ? h("span", { className: "pf-hint" }, "当前无测试切换")
            : h("span", { className: "pf-hint" }, "当前 pin：" + status.pins.map((pin) => String(pin.session) + " → " + String(pin.route) + "/" + String(pin.model)).join("、")),
          testMsg.length > 0 ? h("span", { className: testMsgKind === "error" ? "pf-err" : "pf-ok" }, testMsg) : null),
        h("div", { className: "pf-hint" }, "说明：目标会话默认取最近活跃会话；切换走官方模型选择通路，会同时把该选择存为默认模型；pin 30 分钟后自动失效。"));

      /** 全量测试：对启用档位的每个 provider/model 发最小真实请求，展示状态。 */
      const runProbeAll = async () => {
        setProbeBusy(true);
        setProbeMsgKind("ok");
        setProbeMsg("测试中…（向每个启用条目发送真实最小请求，可能耗时数十秒）");
        try {
          const body = status.lastSessionId === undefined || status.lastSessionId === null ? {} : { sessionId: String(status.lastSessionId) };
          const data = await probeAll(body);
          setProbeReport(data);
          setProbeMsgKind("ok");
          setProbeMsg("完成：" + String(data.summary.ok) + "/" + String(data.summary.total) + " 正常，用时 " + String(data.elapsedMs) + "ms");
        } catch (err) {
          setProbeMsgKind("error");
          setProbeMsg(err.message);
        } finally {
          setProbeBusy(false);
        }
      };

      const probeBadge = (item) =>
        h("span", {
          className: "pf-badge " + (item.status === "OK"
            ? "pf-badge-ok"
            : (item.status === "TIMEOUT" || item.status === "UNSUPPORTED_REASONING_EFFORT" ? "pf-badge-muted" : "pf-badge-failed")),
          title: item.message === undefined ? "" : String(item.message),
        }, String(item.label));

      const probeCard = h("div", { className: "pf-card" },
        h("div", { className: "pf-hint" }, "全量测试——对「启用档位」下的每个 provider/model 发送一条最小真实请求，列出返回状态（额度不足 / 凭据 / 限流 / 网络 / 超时等）。会在真实路由上消耗少量额度；也可在对话窗输入 /failover-probe。"),
        h("div", { className: "pf-actions" },
          h("button", { className: "pf-btn", disabled: probeBusy === true, onClick: runProbeAll }, probeBusy === true ? "测试中…" : "开始全量测试"),
          probeMsg.length > 0 ? h("span", { className: probeMsgKind === "error" ? "pf-err" : "pf-ok" }, probeMsg) : null),
        probeReport === null || probeReport === undefined
          ? h("div", { className: "pf-sub" }, "暂无全量测试结果")
          : h("div", null,
              h("div", { className: "pf-hint" }, "时间：" + new Date(probeReport.at).toLocaleString() + " · 用时 " + String(probeReport.elapsedMs) + "ms · 每目标超时 " + String(probeReport.timeoutMs) + "ms"),
              h("ul", { className: "pf-list" }, probeReport.results.map((item, index) =>
                h("li", { key: String(item.id) + "-" + String(index), className: "pf-mono" },
                  String(item.id) + " → " + String(item.route) + "/" + String(item.model) + " ",
                  probeBadge(item),
                  " " + String(item.ms) + "ms",
                  item.ok === true
                    ? h("span", { className: "pf-hint" }, " · " + String(item.reply))
                    : h("span", { className: "pf-err" }, " · " + String(item.message)))))));

      const numberRow = (key, label, hint) =>
        h("div", { className: "pf-row", key: key },
          h("label", { htmlFor: "pf-" + key }, label),
          h("input", { id: "pf-" + key, type: "number", min: 0, step: 1, value: form[key], onChange: set(key) }),
          hint === undefined ? null : h("span", { className: "pf-hint" }, hint));

      const resetAllKeys = async () => {
        setBusy(true);
        try {
          const data = await resetKeys({});
          setStatus(data.status);
          setForm(data.status.editable);
          setKeyDraft(draftOf(data.status));
          setError("");
          setSaved("已重置全部 key 状态");
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };

      const resetAtRow =
        h("div", { className: "pf-row" },
          h("label", { htmlFor: "pf-keyResetAt" }, "key 每日重置时刻"),
          h("input", { id: "pf-keyResetAt", type: "text", placeholder: "06:00", value: form.keyResetAt, onChange: set("keyResetAt") }),
          h("span", { className: "pf-hint" }, status.nextKeyResetAt === undefined
            ? "本地时间 HH:MM；到点清空失效标记并把默认 key 写回"
            : "本地时间 HH:MM；下次：" + new Date(status.nextKeyResetAt).toLocaleString()));

      return h("div", { className: "pf-root" },
        h("div", null,
          h("div", { className: "pf-title" }, "Provider 故障转移"),
          h("div", { className: "pf-sub" }, "终端失败（额度/凭据/过载/限流等）后按档位顺序切换路由；凭据类失败先在条目内轮换 key（改写该路由的 apiKeyEnv 引用，路由与模型不变）。设置改动即时生效，写入 settings.yaml 的 provider-failover 段。")),

        h("div", { className: "pf-card" },
          h("div", { className: "pf-row" },
            h("label", { htmlFor: "pf-enabled" }, "启用故障转移"),
            h("input", { id: "pf-enabled", type: "checkbox", checked: form.enabled === true, onChange: set("enabled") }),
            h("span", { className: "pf-hint" }, status.enabled === true ? "当前：已启用" : "当前：已停用")),
          numberRow("minSwitchIntervalMs", "最小切换间隔（ms）", "0 = 关闭该护栏"),
          numberRow("maxSwitchesPerTurn", "单 turn 切换上限"),
          numberRow("startupPreferTier", "启动对齐档位", "0 = 完全跟随宿主默认路由"),
          h("div", { className: "pf-row" },
            h("label", { htmlFor: "pf-rankingMode" }, "档内排序模式"),
            h("select", { id: "pf-rankingMode", value: form.rankingMode, onChange: set("rankingMode") },
              RANKING_MODES.map((mode) => h("option", { key: mode.value, value: mode.value }, mode.label)))),
          resetAtRow),

        h("div", { className: "pf-actions" },
          h("button", { className: "pf-btn", disabled: busy === true || dirty !== true, onClick: save }, busy === true ? "保存中…" : "保存"),
          h("button", { className: "pf-btn", disabled: busy === true, onClick: load }, "重新读取"),
          h("button", { className: "pf-btn", disabled: busy === true, onClick: resetAllKeys }, "重置 key 状态"),
          saved.length > 0 ? h("span", { className: "pf-ok" }, saved) : null,
          error.length > 0 ? h("span", { className: "pf-err" }, error) : null,
          status.writable !== true ? h("span", { className: "pf-err" }, "settings 服务未装载，无法在此保存") : null),

        keyCard,

        testCard,

        probeCard,

        h("div", { className: "pf-card" },
          h("div", { className: "pf-hint" }, "档位表（只读，与宿主 provider 目录实时关联）"),
          h("ul", { className: "pf-list pf-mono" },
            status.tiers.map((tier) => h("li", { key: tier.tier },
              "档 " + String(tier.tier) + (tier.enabled === true ? "" : "（关闭）") + "：",
              tier.entries.map((entry, index) => h("span", { key: entry.id },
                index > 0 ? "、" : "",
                String(entry.id) + " → " + String(entry.route) + "/" + String(entry.model),
                entry.registered !== true ? h("span", { className: "pf-warn" }, "［宿主未注册］") : null,
                entry.cooling === true ? h("span", { className: "pf-hint" }, "［冷却中］") : null))))) ),

        h("div", { className: "pf-card" },
          h("div", { className: "pf-hint" }, "Provider 目录（来自宿主 llm.listProviders()）"),
          status.providers === null || status.providers === undefined
            ? h("div", { className: "pf-sub" }, "provider 目录不可用（宿主 llm 未就绪或未报告），档位条目暂不做可用性标注")
            : [
                status.providers.registered.length === 0
                  ? h("div", { className: "pf-sub" }, "宿主未报告任何已注册 provider")
                  : h("ul", { className: "pf-list pf-mono" },
                      status.providers.registered.map((provider) => {
                        const used = status.tiers.some((tier) => tier.entries.some((entry) => entry.route === provider.id));
                        return h("li", { key: provider.id },
                          String(provider.id) + "（" + String(provider.name) + "）",
                          used === true ? h("span", { className: "pf-hint" }, " 已纳入档位") : h("span", { className: "pf-err" }, " 未纳入任何档位"));
                      })),
                status.providers.missing.length === 0
                  ? null
                  : h("div", { className: "pf-err" }, "档位引用了宿主未注册的路由：" + status.providers.missing.join(", ")),
              ]),

        h("div", { className: "pf-card" },
          h("div", { className: "pf-hint" }, "最近未切换原因（最多 10 条，内存态）——请求失败但插件判断不应换 key/换 provider 时记录：策略拒绝 / 请求无效 / 推理档位不兼容 等。"),
          status.ignored === undefined || status.ignored.length === 0
            ? h("div", { className: "pf-sub" }, "暂无记录")
            : h("ul", { className: "pf-list pf-mono" }, status.ignored.map((entry, index) =>
                h("li", { key: index, title: String(entry.message === undefined ? "" : entry.message) }, describeIgnored(entry))))),

        h("div", { className: "pf-card" },
          h("div", { className: "pf-hint" }, "最近转移（最多 10 条，内存态）"),
          status.switches.length === 0
            ? h("div", { className: "pf-sub" }, "暂无转移记录")
            : h("ul", { className: "pf-list pf-mono" }, status.switches.map((entry, index) => h("li", { key: index }, describeSwitch(entry)))),
          status.cooling.length === 0
            ? null
            : h("div", { className: "pf-hint" }, "冷却中：" + status.cooling.map((item) => item.route + "(" + item.code + ")").join(", "))));
    }

    const inject = ["slots"];

    function apply(ctx) {
      const styleTag = document.createElement("style");
      styleTag.setAttribute("data-dsh-provider-failover", "");
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => {
        if (styleTag.parentNode !== null && styleTag.parentNode !== undefined) {
          styleTag.parentNode.removeChild(styleTag);
        }
      });

      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "provider-failover", order: 12, label: "Provider 故障转移" },
        () => react.createElement(ProviderFailoverPanel, null),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
