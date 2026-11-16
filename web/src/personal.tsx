import { computed, defineComponent, onMounted, onUnmounted, ref } from "vue";
import {
  downloadPersonalFile,
  fetchPersonalKnowledge,
  fetchPersonalTask,
  fetchPersonalTasks,
  key,
  local,
  submitPersonalTask,
  type PersonalDetails,
  type PersonalTask,
} from "./hub";

const states: Record<string, string> = {
  dispatching: "等待接单确认",
  queued: "排队",
  running: "执行中",
  returning: "回传中",
  "waiting-review": "待你审核",
  "needs-attention": "需要处理",
  done: "已交付",
  nothing: "无需处理",
  failed: "未完成",
  cancelled: "已停止",
};
const agentNames: Record<string, string> = { codex: "Codex", claude: "Claude Code", zcode: "ZCode" };
const views = [
  {
    id: "attention",
    label: "待处理",
    states: ["waiting-review", "needs-attention", "failed"],
    empty: "没有待处理的任务。",
  },
  {
    id: "active",
    label: "进行中",
    states: ["dispatching", "queued", "running", "returning"],
    empty: "没有正在排队或执行的任务。",
  },
  { id: "archive", label: "任务档案", states: ["done", "nothing", "cancelled"], empty: "还没有结束的任务。" },
] as const;
type TaskView = (typeof views)[number]["id"];
const viewFor = (state: string) =>
  views.find((view) => (view.states as readonly string[]).includes(state))?.id ?? "attention";
const modeName = (mode: string) => (mode === "api" ? "统一网关" : "本机配置");
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const canSubmit = (node: string, agent: string) =>
  !local?.personalTargets || local.personalTargets.includes(node + "/" + agent);

export const Personal = defineComponent({
  setup() {
    const view = ref<Awaited<ReturnType<typeof fetchPersonalTasks>>>();
    const detail = ref<PersonalDetails>();
    const chosen = ref(/^#\/task\/(personal-[a-f0-9]{24})$/.exec(location.hash)?.[1] ?? "");
    const message = ref("");
    const notice = ref("");
    const downloadMessage = ref("");
    const taskNumber = ref("");
    const lookupMessage = ref("");
    const catalog = ref<Awaited<ReturnType<typeof fetchPersonalKnowledge>>>();
    const catalogError = ref("");
    const chosenKnowledge = ref<string[]>([]);
    const filter = ref<TaskView>();
    const taskText = ref("");
    const link = ref("");
    const plan = ref("");
    const target = ref("");
    const model = ref("");
    const selectedAgent = computed(() => {
      const [node, agent] = target.value.split("/");
      return view.value?.devices.find((d) => d.name === node)?.agents.find((a) => a.id === agent);
    });
    const review = ref(true);
    const sending = ref(false);
    let submission = crypto.randomUUID();
    const session = key.value;
    const lifetime = new AbortController();
    const groups = computed(() => {
      const result: Record<TaskView, PersonalTask[]> = { active: [], attention: [], archive: [] };
      for (const task of view.value?.tasks ?? []) result[viewFor(task.state)].push(task);
      if (detail.value && !view.value?.tasks.some((task) => task.id === detail.value?.id)) {
        result[viewFor(detail.value.state)].unshift(detail.value);
      }
      return result;
    });
    const tab = computed(() => filter.value ?? views.find((view) => groups.value[view.id].length)?.id ?? "active");
    const taskState = (task: PersonalTask) => {
      const node = view.value?.devices.find((device) => device.name === task.node);
      if (!message.value && node?.online === false) {
        if (task.state === "running") return "执行机离线";
        if (task.state === "returning") return "回传中 · 执行机离线";
        if (task.state === "queued") return "排队 · 等设备上线";
      }
      return states[task.state] ?? "需要处理";
    };
    let working = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alive = () => !lifetime.signal.aborted && session === key.value;
    const refresh = async () => {
      if (!alive() || working) return;
      working = true;
      clearTimeout(timer);
      try {
        const snapshot = await fetchPersonalTasks(lifetime.signal);
        if (!alive()) return;
        view.value = snapshot;
        if (!target.value) {
          const choices = snapshot.devices.flatMap((node) =>
            node.agents.filter((agent) => canSubmit(node.name, agent.id)).map((agent) => ({ node, agent })),
          );
          const selected =
            choices.find((x) => x.node.online && x.agent.mode === "local") ??
            choices.find((x) => x.agent.mode === "local") ??
            choices[0];
          if (selected) target.value = selected.node.name + "/" + selected.agent.id;
        }
        const id = chosen.value;
        if (id) {
          const selected = await fetchPersonalTask(id, lifetime.signal);
          if (alive() && id === chosen.value) {
            detail.value = selected;
            filter.value = viewFor(selected.state);
          }
        }
        if (alive()) message.value = "";
      } catch {
        if (alive()) message.value = "暂时无法读取个人任务。";
      } finally {
        working = false;
        if (alive()) timer = setTimeout(() => void refresh(), 3000);
      }
    };
    const loadCatalog = async () => {
      catalogError.value = "";
      try {
        const listing = await fetchPersonalKnowledge(lifetime.signal);
        if (alive()) catalog.value = listing;
      } catch {
        if (alive()) catalogError.value = "共享资料暂时读不到。";
      }
    };
    onMounted(() => {
      void refresh();
      if (local?.personalIntake) void loadCatalog();
    });
    onUnmounted(() => {
      clearTimeout(timer);
      lifetime.abort();
    });
    const select = (id: string) => {
      chosen.value = id === chosen.value ? "" : id;
      detail.value = undefined;
      downloadMessage.value = "";
      void refresh();
    };
    const findTask = async (event: Event) => {
      event.preventDefault();
      const id = taskNumber.value.trim();
      if (!/^personal-[a-f0-9]{24}$/.test(id)) {
        lookupMessage.value = "请粘贴回执上的完整任务编号。";
        return;
      }
      lookupMessage.value = "正在查找…";
      try {
        const found = await fetchPersonalTask(id, lifetime.signal);
        if (!alive() || taskNumber.value.trim() !== id) return;
        detail.value = found;
        chosen.value = found.id;
        filter.value = viewFor(found.state);
        downloadMessage.value = lookupMessage.value = "";
      } catch {
        if (alive() && taskNumber.value.trim() === id) lookupMessage.value = "无法打开这条任务，请核对编号后重试。";
      }
    };
    const submit = async (event: Event) => {
      event.preventDefault();
      if (sending.value || !taskText.value.trim() || !target.value) return;
      sending.value = true;
      notice.value = "正在读取资料并提交…";
      const [node, agent] = target.value.split("/");
      try {
        const result = await submitPersonalTask({
          id: submission,
          text: taskText.value,
          link: link.value,
          plan: plan.value,
          node,
          agent,
          review: review.value,
          knowledge: chosenKnowledge.value,
          ...(selectedAgent.value?.mode === "api" && model.value && { model: model.value }),
        });
        if (!alive()) return;
        chosen.value = result.id;
        detail.value = undefined;
        downloadMessage.value = "";
        filter.value = viewFor(result.state);
        notice.value = `已收到任务 ${result.id}。执行电脑在线后开始处理，成果会出现在任务详情里。`;
        taskText.value = link.value = plan.value = "";
        chosenKnowledge.value = [];
        submission = crypto.randomUUID();
        await refresh();
      } catch (error) {
        if (alive()) notice.value = (error as Error).message;
      } finally {
        sending.value = false;
      }
    };
    return () => (
      <section class="bench-section personal-desk" id="personal-desk" tabindex="-1">
        <div class="personal-desk-head">
          <h2>个人任务</h2>
          <a href="#/dispatch">打开任务配置</a>
          <span>
            {view.value ? view.value.devices.filter((item) => item.online).length + " 台电脑在线" : "正在连接"}
          </span>
        </div>
        <div class="personal-desk-body">
          <div class="personal-desk-main">
            {local?.personalIntake && (
              <form
                class="personal-intake"
                onSubmit={submit}
                onInput={() => {
                  if (!sending.value) submission = crypto.randomUUID();
                }}
              >
                <div class="personal-intake-title">
                  <h3>交给 Agent 一件事</h3>
                </div>
                <label class="personal-wide">
                  任务要求
                  <textarea
                    required
                    rows={3}
                    maxlength={12000}
                    disabled={sending.value}
                    value={taskText.value}
                    onInput={(e) => (taskText.value = (e.target as HTMLTextAreaElement).value)}
                    placeholder="希望完成什么？需要哪些成果？"
                  />
                </label>
                {local.feishuIntake && (
                  <>
                    <label>
                      飞书任务或方案链接
                      <input
                        type="url"
                        disabled={sending.value}
                        value={link.value}
                        onInput={(e) => (link.value = (e.target as HTMLInputElement).value)}
                        placeholder="粘贴你希望处理的链接（可选）"
                      />
                    </label>
                    <label>
                      对应方案链接
                      <input
                        type="url"
                        disabled={sending.value}
                        value={plan.value}
                        onInput={(e) => (plan.value = (e.target as HTMLInputElement).value)}
                        placeholder="任务中有多个方案时填写"
                      />
                    </label>
                  </>
                )}
                <label class="personal-wide">
                  执行电脑与 Agent
                  <select
                    required
                    disabled={sending.value}
                    value={target.value}
                    onChange={(e) => {
                      target.value = (e.target as HTMLSelectElement).value;
                      model.value = "";
                      submission = crypto.randomUUID();
                    }}
                  >
                    <option value="">请选择</option>
                    {view.value?.devices.flatMap((node) =>
                      node.agents
                        .filter((agent) => canSubmit(node.name, agent.id))
                        .map((agent) => (
                          <option key={node.name + "/" + agent.id} value={node.name + "/" + agent.id}>
                            {node.name} · {agentNames[agent.use] ?? agent.use} · {agent.id}
                            {node.online ? "（在线）" : "（离线，先排队）"}
                          </option>
                        )),
                    )}
                  </select>
                </label>
                {selectedAgent.value?.mode === "api" && (
                  <label>
                    本次任务模型
                    <select
                      aria-label="本次任务模型"
                      value={model.value}
                      disabled={sending.value}
                      onChange={(e) => {
                        model.value = (e.target as HTMLSelectElement).value;
                        submission = crypto.randomUUID();
                      }}
                    >
                      <option value="">
                        使用默认模型（{selectedAgent.value.defaultModel ?? selectedAgent.value.model ?? "服务器配置"}）
                      </option>
                      {selectedAgent.value.models?.map((id) => (
                        <option value={id}>{id}</option>
                      ))}
                    </select>
                  </label>
                )}
                <details class="personal-wide personal-catalog">
                  <summary>
                    选择共享资料 {chosenKnowledge.value.length ? `（已选 ${chosenKnowledge.value.length}）` : ""}
                  </summary>
                  {catalogError.value && (
                    <p role="status">
                      {catalogError.value}{" "}
                      <button type="button" class="word" onClick={loadCatalog}>
                        重试
                      </button>
                    </p>
                  )}
                  {!catalogError.value && !catalog.value && <p>正在读取共享资料…</p>}
                  {catalog.value?.length === 0 && <p>暂无共享资料。</p>}
                  {catalog.value?.map((file) => (
                    <label class="personal-catalog-item" key={file.id}>
                      <input
                        type="checkbox"
                        disabled={
                          sending.value ||
                          (chosenKnowledge.value.length >= 31 && !chosenKnowledge.value.includes(file.id))
                        }
                        checked={chosenKnowledge.value.includes(file.id)}
                        onChange={(event) => {
                          if ((event.target as HTMLInputElement).checked)
                            chosenKnowledge.value = [...chosenKnowledge.value, file.id];
                          else chosenKnowledge.value = chosenKnowledge.value.filter((id) => id !== file.id);
                          submission = crypto.randomUUID();
                        }}
                      />
                      <span>{file.name}</span>
                      <small>
                        {size(file.bytes)} · {file.id.slice(0, 7)}
                      </small>
                    </label>
                  ))}
                </details>
                <div class="personal-intake-actions personal-wide">
                  <label>
                    <input
                      type="checkbox"
                      disabled={sending.value}
                      checked={review.value}
                      onChange={(e) => {
                        review.value = (e.target as HTMLInputElement).checked;
                        submission = crypto.randomUUID();
                      }}
                    />
                    先交草稿，等我审核
                  </label>
                  <button type="submit" disabled={sending.value || !target.value}>
                    {sending.value ? "提交中…" : "提交任务"}
                  </button>
                </div>
                {notice.value && (
                  <p class="personal-wide bench-feedback" role="status">
                    {notice.value}
                  </p>
                )}
              </form>
            )}
            {message.value && (
              <p class="bench-empty" role="status">
                {message.value}
              </p>
            )}
            {view.value && (
              <>
                <details class="personal-lookup">
                  <summary>用任务编号找成果</summary>
                  <form onSubmit={findTask}>
                    <input
                      aria-label="任务编号"
                      placeholder="粘贴任务编号"
                      value={taskNumber.value}
                      onInput={(event) => {
                        taskNumber.value = (event.target as HTMLInputElement).value;
                        lookupMessage.value = "";
                      }}
                    />
                    <button class="word" type="submit">
                      查找
                    </button>
                  </form>
                  {lookupMessage.value && <p role="status">{lookupMessage.value}</p>}
                </details>
                <div class="personal-filters" role="group" aria-label="按任务状态查看">
                  {views.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      aria-pressed={tab.value === item.id}
                      onClick={() => {
                        filter.value = item.id;
                        chosen.value = "";
                        detail.value = undefined;
                      }}
                    >
                      {item.label}
                      <b>{groups.value[item.id].length}</b>
                    </button>
                  ))}
                </div>
                <ul class="personal-task-list">
                  {groups.value[tab.value].map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        class="personal-task"
                        aria-expanded={chosen.value === task.id}
                        onClick={() => select(task.id)}
                      >
                        <span class="personal-task-name">
                          <strong>{task.title ?? (task.run ? `任务 #${task.run}` : task.id)}</strong>
                          <small>
                            {task.node} · {task.use ? (agentNames[task.use] ?? task.use) : task.agent} ·{" "}
                            {modeName(task.mode)}
                          </small>
                        </span>
                        <span class={["personal-state", task.state]}>{taskState(task)}</span>
                      </button>
                      {chosen.value === task.id &&
                        (detail.value?.id === task.id ? (
                          <div class="personal-task-detail">
                            <div class="personal-detail-meta">
                              <span>{task.run ? `运行 #${task.run}` : "尚未领取"}</span>
                              <span>
                                {detail.value.cleanup.length
                                  ? detail.value.cleanup.some((entry) => !entry.cleaned)
                                    ? "等待本机清理"
                                    : "本机已清理"
                                  : ""}
                              </span>
                            </div>
                            <p class="personal-task-id">
                              任务编号 <code>{task.id}</code>
                            </p>
                            {detail.value.files.length === 0 && <p>暂无可下载成果。</p>}
                            {detail.value.files.map((file) => (
                              <div class="personal-file" key={file.id}>
                                <span>
                                  {file.name}
                                  <small>{size(file.bytes)}</small>
                                </span>
                                <button
                                  type="button"
                                  class="word"
                                  onClick={() => {
                                    downloadMessage.value = "";
                                    void downloadPersonalFile(task.id, file.id, file.name).catch((error: Error) => {
                                      if (alive() && chosen.value === task.id) downloadMessage.value = error.message;
                                    });
                                  }}
                                >
                                  下载
                                </button>
                              </div>
                            ))}
                            {downloadMessage.value && <p role="status">{downloadMessage.value}</p>}
                          </div>
                        ) : (
                          <p class="bench-empty" role="status">
                            {message.value ? "暂时无法读取任务详情。" : "正在读取成果…"}
                          </p>
                        ))}
                    </li>
                  ))}
                </ul>
                {!groups.value[tab.value].length && (
                  <p class="bench-empty">{views.find((item) => item.id === tab.value)?.empty}</p>
                )}
              </>
            )}
          </div>
          <aside class="personal-devices" aria-label="电脑与 Agent">
            <h3>电脑与 Agent</h3>
            {view.value?.devices.map((node) => (
              <div class="personal-device" key={node.name}>
                <div class="personal-device-name">
                  <strong>{node.name}</strong>
                  <span class={["personal-online", !message.value && node.online && "up"]}>
                    {message.value ? "上次状态" : node.online ? "在线" : "离线"}
                  </span>
                </div>
                <ul>
                  {node.agents.map((agent) => (
                    <li key={agent.id}>
                      <span>
                        {agentNames[agent.use] ?? agent.use}
                        <small>
                          {agent.id}
                          {agent.model && ` · ${agent.model}`}
                        </small>
                      </span>
                      <span class="personal-mode">{modeName(agent.mode)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </aside>
        </div>
      </section>
    );
  },
});
