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
      ".pf-actions{display:flex;align-items:center;gap:10px}",
      ".pf-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}",
      ".pf-btn[disabled]{opacity:.5;cursor:default}",
      ".pf-ok{color:var(--dsw-alias-state-success-primary)}",
      ".pf-err{color:var(--dsw-alias-state-error-primary)}",
      ".pf-mono{font-family:var(--dsw-font-mono,monospace);font-size:12px}",
      ".pf-list{margin:0;padding-left:18px}",
    ].join("");

    async function apiFetch(url, options) {
      const response = await fetch(url, Object.assign({}, options, { signal: AbortSignal.timeout(15000) }));
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
    const resetKeys = (body) =>
      apiFetch(ROUTE + "/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body === undefined ? {} : body),
      });

    function describeSwitch(entry) {
      if (entry === null || entry === undefined) return "";
      if (entry.kind === "startup-align") {
        return "启动对齐 " + String(entry.from) + " → " + String(entry.to) + "（档 " + String(entry.tier) + "）";
      }
      return String(entry.from) + " → " + String(entry.to) + "（档 " + String(entry.tier) + "，" + String(entry.code) + "）";
    }

    function ProviderFailoverPanel() {
      const [status, setStatus] = react.useState(null);
      const [form, setForm] = react.useState(null);
      const [error, setError] = react.useState("");
      const [saved, setSaved] = react.useState("");
      const [busy, setBusy] = react.useState(false);

      const load = react.useCallback(async () => {
        try {
          const data = await getStatus();
          setStatus(data);
          setForm(data.editable);
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
      if (status === null || form === null) {
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
          setError("");
          setSaved("已保存并即时生效");
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };

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
          setError("");
          setSaved("已重置全部 key 状态");
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };

      /** 条目内 key 引用的一行说明：只显示引用名与状态，永不显示值。 */
      const keyLine = (entry) =>
        entry.keys.length === 0
          ? null
          : h("div", { className: "pf-hint" },
              "key：" + entry.keys.map((key) =>
                key.ref
                + (key.active === true ? "（生效）" : "")
                + (key.failed === true ? "［本周期失效］" : "")
                + (key.configured !== true ? "［未配置］" : "")
                + (key.source === "env" ? "［环境·只读］" : "")).join(" → "));

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

        h("div", { className: "pf-card" },
          h("div", { className: "pf-hint" }, "档位表（只读，与宿主 provider 目录实时关联）"),
          h("ul", { className: "pf-list pf-mono" },
            status.tiers.map((tier) => h("li", { key: tier.tier },
              "档 " + String(tier.tier) + (tier.enabled === true ? "" : "（关闭）") + "：",
              tier.entries.map((entry, index) => h("span", { key: entry.id },
                index > 0 ? "、" : "",
                String(entry.id) + " → " + String(entry.route) + "/" + String(entry.model),
                entry.registered !== true ? h("span", { className: "pf-warn" }, "［宿主未注册］") : null,
                keyLine(entry),
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
