import { computed, defineComponent, onMounted, onUnmounted, ref } from "vue";
import {
  configureTask,
  discardTask,
  fetchGateway,
  fetchInbox,
  fetchPersonalTasks,
  key,
  local,
  submitPersonalTask,
  type GatewayView,
  type InboxTask,
} from "./hub";
import "./dispatch.css";

const names: Record<string, string> = { codex: "Codex", claude: "Claude Code", zcode: "ZCode" };
const modeName = (mode: string) => (mode === "api" ? "统一网关" : "本机配置");

export const Dispatch = defineComponent({
  setup() {
    const inbox = ref<InboxTask[]>([]);
    const devices = ref<Awaited<ReturnType<typeof fetchPersonalTasks>>["devices"]>([]);
    const gateway = ref<GatewayView>();
    const selected = ref("");
    const creating = ref(false);
    const text = ref("");
    const link = ref("");
    const family = ref("");
    const target = ref("");
    const model = ref("");
    const busy = ref(false);
    const loaded = ref(false);
    const error = ref("");
    const result = ref<{ id: string; state: string }>();
    const life = new AbortController();
    const session = key.value;
    const alive = () => !life.signal.aborted && key.value === session;
    let submission = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const choices = computed(() =>
      devices.value.flatMap((node) =>
        node.agents
          .filter(
            (agent) =>
              (!local?.personalTargets || local.personalTargets.includes(node.name + "/" + agent.id)) &&
              (agent.mode !== "api" || !!agent.models?.length),
          )
          .map((agent) => ({ node, agent, value: node.name + "/" + agent.id, family: agent.use + "/" + agent.mode })),
      ),
    );
    const families = computed(() => [...new Map(choices.value.map((c) => [c.family, c.agent])).entries()]);
    const current = computed(() => choices.value.find((c) => c.value === target.value));
    const draft = computed(() => inbox.value.find((item) => item.id === selected.value));
    const modelLabel = (id: string) => gateway.value?.models?.find((m) => m.id === id)?.label ?? id;
    const chooseTarget = (value: string) => {
      target.value = value;
      const agent = choices.value.find((c) => c.value === value)?.agent;
      model.value = agent?.mode === "api" ? (agent.defaultModel ?? agent.model ?? "") : "";
    };
    const chooseFamily = (value: string) => {
      family.value = value;
      const options = choices.value.filter((c) => c.family === value);
      chooseTarget((options.find((c) => c.node.online) ?? options[0])?.value ?? "");
    };
    const select = (id: string) => {
      selected.value = id;
      creating.value = false;
      result.value = undefined;
      error.value = "";
    };
    const refresh = async () => {
      clearTimeout(timer);
      try {
        const [pending, tasks] = await Promise.all([fetchInbox(life.signal), fetchPersonalTasks(life.signal)]);
        if (!alive()) return;
        inbox.value = pending;
        devices.value = tasks.devices;
        loaded.value = true;
        const submitted = tasks.tasks.find((task) => task.id === selected.value);
        if (submitted && !pending.some((item) => item.id === selected.value)) {
          result.value = submitted;
          selected.value = "";
        }
        if (!families.value.some(([id]) => id === family.value))
          chooseFamily(families.value.find(([, a]) => a.mode === "api")?.[0] ?? families.value[0]?.[0] ?? "");
        if (!selected.value && !creating.value && !result.value) selected.value = pending[0]?.id ?? "";
      } catch {
        if (alive()) error.value = "暂时无法读取任务。请确认小镇连接正常。";
      } finally {
        if (alive()) timer = setTimeout(() => void refresh(), 4000);
      }
    };
    onMounted(() => {
      void refresh();
      void fetchGateway(life.signal)
        .then((value) => {
          if (alive()) gateway.value = value;
        })
        .catch(() => {});
    });
    onUnmounted(() => {
      life.abort();
      clearTimeout(timer);
    });
    const canDispatch = computed(
      () =>
        !busy.value &&
        !!current.value &&
        (creating.value ? !!text.value.trim() : !!draft.value) &&
        (current.value.agent.mode !== "api" || !!current.value.agent.models?.includes(model.value)),
    );
    const send = async (event: Event) => {
      event.preventDefault();
      if (!canDispatch.value || !current.value) return;
      busy.value = true;
      error.value = "";
      const choice = {
        node: current.value.node.name,
        agent: current.value.agent.id,
        ...(current.value.agent.mode === "api" && { model: model.value }),
      };
      try {
        const accepted = creating.value
          ? await submitPersonalTask({
              id: submission,
              text: text.value,
              link: link.value,
              plan: "",
              review: true,
              ...choice,
            })
          : await configureTask(selected.value, choice);
        if (!alive()) return;
        result.value = accepted;
        selected.value = "";
        creating.value = false;
        text.value = link.value = "";
        submission = crypto.randomUUID();
        await refresh();
      } catch (failure) {
        if (alive()) error.value = (failure as Error).message;
      } finally {
        busy.value = false;
      }
    };
    const discard = async () => {
      if (!draft.value || busy.value) return;
      busy.value = true;
      try {
        await discardTask(draft.value.id);
        if (alive()) {
          selected.value = "";
          await refresh();
        }
      } catch (failure) {
        if (alive()) error.value = (failure as Error).message;
      } finally {
        busy.value = false;
      }
    };
    return () => (
      <div class="shell console town-console dispatch-shell">
        <header class="bar">
          <a class="brand" href="#/">
            Agent Autoloop
          </a>
          <a class="board-link" href="#/">
            返回小镇
          </a>
        </header>
        <main class="dispatch-page">
          <header class="dispatch-heading">
            <div>
              <span class="dispatch-eyebrow">TASK DESK / 任务调度</span>
              <h1>你决定，谁来做。</h1>
              <p>飞书收件 · 选择 Agent 与模型 · 确认后执行</p>
            </div>
            <span class="dispatch-pending">{inbox.value.length} 项待配置</span>
          </header>
          <div class="dispatch-layout">
            <aside class="dispatch-inbox" aria-label="待配置任务">
              <div class="dispatch-inbox-head">
                <h2>收件箱</h2>
                <button
                  type="button"
                  disabled={busy.value || !local?.personalIntake}
                  onClick={() => {
                    creating.value = true;
                    selected.value = "";
                    result.value = undefined;
                    error.value = "";
                  }}
                >
                  新建任务
                </button>
              </div>
              <p class="dispatch-muted">指定群里 @ 机器人后，任务会在这里等你。</p>
              {inbox.value.map((item) => (
                <button
                  type="button"
                  class={["dispatch-item", selected.value === item.id && "selected"]}
                  disabled={busy.value}
                  onClick={() => select(item.id)}
                  key={item.id}
                >
                  <span>
                    {item.source}{" "}
                    <time>
                      {new Date(item.created).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </span>
                  <strong>{item.text.slice(0, 90)}</strong>
                  <small>{item.files.length} 份资料 · 等待选择</small>
                </button>
              ))}
              {!inbox.value.length && (
                <p class="dispatch-empty">{loaded.value ? "暂无待配置任务。你也可以直接新建。" : "正在读取收件箱…"}</p>
              )}
            </aside>
            <section class="dispatch-config" aria-label="任务配置">
              {result.value ? (
                <div class="dispatch-success" role="status">
                  <span class="dispatch-eyebrow">已确认</span>
                  <h2>{result.value.state === "needs-attention" ? "任务已保存，需要检查派发规则" : "任务已提交"}</h2>
                  <p>这份任务的电脑、Agent 和模型已经固定。电脑离线时等待上线，不会自动改派。</p>
                  <code>{result.value.id}</code>
                  <a class="dispatch-primary" href={"#/task/" + result.value.id}>
                    查看任务进度与成果
                  </a>
                </div>
              ) : draft.value || creating.value ? (
                <form onSubmit={send}>
                  <fieldset disabled={busy.value}>
                    <section class="dispatch-step">
                      <h2>
                        <span>01</span>任务与资料
                      </h2>
                      {creating.value ? (
                        <>
                          <label>
                            任务要求
                            <textarea
                              required
                              rows={4}
                              maxlength={12000}
                              value={text.value}
                              onInput={(e) => (text.value = (e.target as HTMLTextAreaElement).value)}
                              placeholder="描述要做什么，以及希望得到的成果"
                            />
                          </label>
                          {local?.feishuIntake && (
                            <label>
                              飞书资料链接（可选）
                              <input
                                type="url"
                                value={link.value}
                                onInput={(e) => (link.value = (e.target as HTMLInputElement).value)}
                                placeholder="粘贴任务或方案文档链接"
                              />
                            </label>
                          )}
                          <p class="dispatch-muted">新建任务先交草稿，等待你的审核。</p>
                        </>
                      ) : (
                        <>
                          <p class="dispatch-task-text">{draft.value?.text}</p>
                          <div class="dispatch-files">
                            {draft.value?.files.map((file) => (
                              <span key={file.name}>{file.name}</span>
                            ))}
                          </div>
                          <p class="dispatch-muted">已保存收件时的资料版本。成果仍按原任务的私聊设置交付。</p>
                        </>
                      )}
                    </section>
                    <section class="dispatch-step">
                      <h2>
                        <span>02</span>选择执行 Agent
                      </h2>
                      <div class="dispatch-agents" role="group" aria-label="选择 Agent">
                        {families.value.map(([id, agent]) => (
                          <button
                            type="button"
                            key={id}
                            aria-pressed={family.value === id}
                            onClick={() => chooseFamily(id)}
                          >
                            <strong>{names[agent.use] ?? agent.use}</strong>
                            <small>{modeName(agent.mode)}</small>
                          </button>
                        ))}
                      </div>
                      <label>
                        执行电脑
                        <select
                          aria-label="执行电脑"
                          required
                          value={target.value}
                          onChange={(e) => chooseTarget((e.target as HTMLSelectElement).value)}
                        >
                          {choices.value
                            .filter((c) => c.family === family.value)
                            .map((c) => (
                              <option value={c.value} key={c.value}>
                                {c.node.name} · {c.node.online ? "在线" : "离线，等待上线"} · {c.agent.id}
                              </option>
                            ))}
                        </select>
                      </label>
                    </section>
                    <section class="dispatch-step">
                      <h2>
                        <span>03</span>选择本次模型
                      </h2>
                      {current.value?.agent.mode === "api" ? (
                        <>
                          <label>
                            本次任务模型
                            <select
                              aria-label="本次任务模型"
                              required
                              value={model.value}
                              onChange={(e) => (model.value = (e.target as HTMLSelectElement).value)}
                            >
                              {current.value.agent.models?.map((id) => (
                                <option value={id} key={id}>
                                  {modelLabel(id)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <p class="dispatch-muted">
                            只使用这次选择，不改变其他任务或 Agent 的默认模型。供应商密钥由服务器保管。
                          </p>
                          {gateway.value?.models?.find((m) => m.id === model.value)?.billing === "subscription" && (
                            <p class="dispatch-muted">此模型使用订阅额度；套餐余量暂未接入。</p>
                          )}
                        </>
                      ) : (
                        <p class="dispatch-muted">
                          此 Agent 使用本机已有的登录与模型配置。要在这里选模型，请选择「统一网关」方式。
                        </p>
                      )}
                    </section>
                    <div class="dispatch-confirm">
                      <div>
                        <strong>
                          {current.value
                            ? `${names[current.value.agent.use] ?? current.value.agent.use} · ${model.value ? modelLabel(model.value) : "本机配置"}`
                            : "请先选择 Agent"}
                        </strong>
                        <small>{current.value?.node.name} · 一台电脑、一个 Agent 接单</small>
                      </div>
                      <button class="dispatch-primary" type="submit" disabled={!canDispatch.value}>
                        {busy.value ? "正在确认…" : "确认派发"}
                      </button>
                    </div>
                    {draft.value && (
                      <button class="dispatch-discard" type="button" onClick={discard}>
                        忽略这项任务
                      </button>
                    )}
                  </fieldset>
                </form>
              ) : (
                <div class="dispatch-empty-main">
                  <span class="dispatch-eyebrow">等待下一件事</span>
                  <h2>从左侧选择任务</h2>
                  <p>这里决定由哪个 Agent、哪个模型、哪台电脑执行。确认前不会消耗模型额度。</p>
                </div>
              )}
              {error.value && (
                <p class="dispatch-error" role="alert">
                  {error.value}
                </p>
              )}
            </section>
          </div>
        </main>
      </div>
    );
  },
});
