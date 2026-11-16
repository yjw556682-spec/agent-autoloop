import { computed, defineComponent, onMounted, onUnmounted, ref } from "vue";
import "./models.css";
import {
  fetchGateway,
  key,
  probeModel,
  setAgentModel,
  type GatewayView,
  type ModelProbe,
  type ModelProtocol,
} from "./hub";

const protocols: Record<ModelProtocol, string> = {
  chat: "Chat Completions",
  messages: "Messages · Claude Code",
  responses: "Responses · Codex",
};
const money = (n: number) => "$" + n.toFixed(6);
export const Models = defineComponent({
  setup() {
    const data = ref<GatewayView>();
    const error = ref("");
    const notice = ref("");
    const busy = ref(false);
    const loading = ref(false);
    const model = ref("");
    const protocol = ref<ModelProtocol>("chat");
    const prompt = ref("请只回复：模型连接成功。");
    const result = ref<ModelProbe>();
    const session = key.value;
    const lifetime = new AbortController();
    const alive = () => !lifetime.signal.aborted && key.value === session;
    const selected = computed(() => data.value?.models?.find((m) => m.id === model.value));
    const refresh = async () => {
      if (loading.value || !alive()) return;
      loading.value = true;
      try {
        const next = await fetchGateway(lifetime.signal);
        if (!alive()) return;
        data.value = next;
        error.value = "";
        if (!model.value && next.models?.length) {
          model.value = next.defaultModel;
          protocol.value = next.models.find((m) => m.id === model.value)?.protocols[0] ?? "chat";
        }
      } catch {
        if (alive()) error.value = "暂时无法读取模型网关，请重试。";
      } finally {
        loading.value = false;
      }
    };
    onMounted(refresh);
    onUnmounted(() => lifetime.abort());
    const changeDefault = async (node: string, agent: string, value: string) => {
      busy.value = true;
      notice.value = "正在保存…";
      try {
        await setAgentModel(node, agent, value);
        if (alive()) {
          notice.value = "已保存，只影响之后提交的新任务。";
          await refresh();
        }
      } catch (e) {
        if (alive()) notice.value = (e as Error).message;
      } finally {
        busy.value = false;
      }
    };
    const test = async (event: Event) => {
      event.preventDefault();
      if (busy.value) return;
      busy.value = true;
      result.value = undefined;
      notice.value = "正在通过统一网关调用模型…";
      try {
        const response = await probeModel(model.value, protocol.value, prompt.value);
        if (alive()) {
          result.value = response;
          notice.value = "本次临时密钥已撤销。用量账目可能稍后更新。";
          await refresh();
        }
      } catch (e) {
        if (alive()) notice.value = (e as Error).message;
      } finally {
        busy.value = false;
      }
    };
    return () => (
      <section class="model-center" id="model-center" aria-label="模型中心">
        <header class="model-head">
          <div>
            <span class="model-eyebrow">MODEL GATEWAY</span>
            <h2>模型中心</h2>
            <p>选好模型，再交给 Agent 执行。</p>
          </div>
          <div class="model-head-actions">
            <span class={["model-status", data.value?.connected && !error.value && "ok"]}>
              {error.value ? "状态未更新" : data.value?.connected ? "网关已连接" : "等待连接"}
            </span>
            <button class="word" disabled={loading.value || busy.value} onClick={refresh}>
              {loading.value ? "读取中…" : "刷新"}
            </button>
          </div>
        </header>
        {error.value && (
          <p role="alert" class="model-notice">
            {error.value}
          </p>
        )}
        {data.value?.configured === false && <p class="model-notice">尚未配置统一模型网关。</p>}
        {data.value?.configured && (
          <>
            <div class="model-stats">
              <div>
                <small>接入模型</small>
                <strong>{data.value.models.length}</strong>
                <span>{new Set(data.value.models.map((m) => m.provider)).size} 个供应商</span>
              </div>
              <div>
                <small>近 7 天调用</small>
                <strong>{data.value.usage?.requests ?? "—"}</strong>
                <span>失败 {data.value.usage?.failed ?? "—"} 次</span>
              </div>
              <div>
                <small>近 7 天 Token</small>
                <strong>{data.value.usage?.tokens.toLocaleString() ?? "—"}</strong>
                <span>包含连接测试</span>
              </div>
              <div>
                <small>网关估算费用</small>
                <strong>{data.value.usage ? money(data.value.usage.usd) : "—"}</strong>
                <span>不代表订阅剩余额度</span>
              </div>
            </div>
            {!data.value.usage && <p class="model-notice">用量账目暂不可用，未按零费用展示。</p>}
            <div class="model-cards">
              {data.value.models.map((m) => {
                const checks = data.value!.checks.filter((c) => c.model === m.id);
                const usage = data.value!.usage?.models.find((x) => x.model === m.id);
                return (
                  <article class="model-card" key={m.id}>
                    <div class="model-card-top">
                      <span>{m.provider}</span>
                      <small>{m.group}</small>
                    </div>
                    <h3>{m.label}</h3>
                    <code>{m.id}</code>
                    <p class="model-muted">
                      {m.billing === "subscription" ? "订阅凭据 · 套餐额度以供应商为准" : "按量调用 · 由网关记录用量"}
                    </p>
                    <div class="model-protocols">
                      {m.protocols.map((p) => {
                        const check = checks.find((c) => c.protocol === p);
                        return (
                          <span
                            title={check ? new Date(check.checkedAt).toLocaleString() : "尚未试调用"}
                            class={check?.ok ? "ok" : ""}
                          >
                            {protocols[p]} · {check ? (check.ok ? "测试通过" : "需检查") : "待测试"}
                          </span>
                        );
                      })}
                    </div>
                    <footer>
                      <span>{m.available ? "网关已登记" : "网关未返回该模型"}</span>
                      <span>
                        {data.value!.usage
                          ? `${usage?.requests ?? 0} 次 · ${m.billing === "subscription" ? "订阅额度" : money(usage?.usd ?? 0)}`
                          : "用量暂不可用"}
                      </span>
                    </footer>
                  </article>
                );
              })}
            </div>
            <div class="model-workspace">
              <section class="model-settings">
                <h3>Agent 默认模型</h3>
                <p class="model-muted">只影响新任务；每单也可以单独选择。</p>
                {data.value.bindings
                  .filter((b) => b.models.length)
                  .map((b) => (
                    <label key={b.node + b.agent}>
                      <span>
                        {b.use === "claude" ? "Claude Code" : b.use === "codex" ? "Codex" : "ZCode"}
                        <small>
                          {b.node} · {b.agent}
                        </small>
                      </span>
                      <select
                        aria-label={b.node + " " + b.agent + " 默认模型"}
                        disabled={busy.value}
                        value={b.model}
                        onChange={(e) => void changeDefault(b.node, b.agent, (e.target as HTMLSelectElement).value)}
                      >
                        {b.models.map((id) => (
                          <option value={id}>{data.value!.models.find((m) => m.id === id)?.label ?? id}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                <p class="model-muted">本机登录模式仍由 Agent 自己的配置决定；这里设置的是统一 API 模式。</p>
                <div class="model-policy">
                  <span>
                    每轮按量限额 <b>${data.value.budget}</b>
                  </span>
                  <span>
                    有效期 <b>{data.value.durationMinutes} 分钟</b>
                  </span>
                  <span>交付或取消后撤销</span>
                </div>
              </section>
              <form class="model-playground" onSubmit={test}>
                <h3>试调用 API</h3>
                <p class="model-muted">通过临时密钥发一次真实请求，会消耗对应模型额度。</p>
                <div class="model-selectors">
                  <label>
                    模型
                    <select
                      aria-label="试调用模型"
                      disabled={busy.value}
                      value={model.value}
                      onChange={(e) => {
                        model.value = (e.target as HTMLSelectElement).value;
                        protocol.value = selected.value?.protocols[0] ?? "chat";
                        result.value = undefined;
                      }}
                    >
                      {data.value.models.map((m) => (
                        <option value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    接口
                    <select
                      aria-label="试调用接口"
                      disabled={busy.value}
                      value={protocol.value}
                      onChange={(e) => {
                        protocol.value = (e.target as HTMLSelectElement).value as ModelProtocol;
                        result.value = undefined;
                      }}
                    >
                      {selected.value?.protocols.map((p) => (
                        <option value={p}>{protocols[p]}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  测试内容
                  <textarea
                    rows={3}
                    maxlength={4000}
                    required
                    disabled={busy.value}
                    value={prompt.value}
                    onInput={(e) => (prompt.value = (e.target as HTMLTextAreaElement).value)}
                  />
                </label>
                <button
                  class="model-primary"
                  disabled={busy.value || !selected.value?.available || !prompt.value.trim()}
                >
                  {busy.value ? "处理中…" : "发送一次测试"}
                </button>
                {result.value && (
                  <div class={["model-result", result.value.ok && "ok"]} role="status">
                    <strong>{result.value.ok ? "调用成功" : "调用未通过"}</strong>
                    <small>
                      {(result.value.ms / 1000).toFixed(1)} 秒 · {result.value.tokens} Token
                    </small>
                    <pre>{result.value.text || result.value.error}</pre>
                  </div>
                )}
              </form>
            </div>
            {notice.value && (
              <p class="model-notice" role="status">
                {notice.value}
              </p>
            )}
            <details class="model-api-notes">
              <summary>API 接入说明</summary>
              <p>执行电脑通过自己的连接通道访问服务器网关。每轮自动领取限定模型的临时密钥；供应商密钥保留在服务器。</p>
              <code>POST /v1/chat/completions · POST /v1/messages · POST /v1/responses</code>
              <p>API 格式互通不代表所有 Agent 功能都已通过验证。新模型需要先试调用，再验证 Agent 的工具使用。</p>
            </details>
          </>
        )}
      </section>
    );
  },
});
