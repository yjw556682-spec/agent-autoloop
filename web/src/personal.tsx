import { defineComponent, onMounted, onUnmounted, ref } from "vue";
import {
  downloadPersonalFile,
  fetchPersonalTask,
  fetchPersonalTasks,
  key,
  local,
  submitPersonalTask,
  type PersonalDetails,
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
const canSubmit = (node: string, agent: string) =>
  !local?.personalTargets || local.personalTargets.includes(node + "/" + agent);

export const Personal = defineComponent({
  setup() {
    const view = ref<Awaited<ReturnType<typeof fetchPersonalTasks>>>();
    const detail = ref<PersonalDetails>();
    const chosen = ref("");
    const message = ref("");
    const notice = ref("");
    const taskText = ref("");
    const link = ref("");
    const plan = ref("");
    const target = ref("");
    const review = ref(true);
    const sending = ref(false);
    let submission = crypto.randomUUID();
    const session = key.value;
    const lifetime = new AbortController();
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
          if (alive() && id === chosen.value) detail.value = selected;
        }
        if (alive()) message.value = "";
      } catch {
        if (alive()) message.value = "暂时无法读取个人任务。";
      } finally {
        working = false;
        if (alive()) timer = setTimeout(() => void refresh(), 3000);
      }
    };
    onMounted(() => void refresh());
    onUnmounted(() => {
      clearTimeout(timer);
      lifetime.abort();
    });
    const select = (id: string) => {
      chosen.value = id === chosen.value ? "" : id;
      detail.value = undefined;
      void refresh();
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
        });
        if (!alive()) return;
        chosen.value = result.id;
        notice.value = "任务已保存到服务器。执行电脑在线后开始处理，成果会出现在下方。";
        taskText.value = link.value = plan.value = "";
        submission = crypto.randomUUID();
        await refresh();
      } catch (error) {
        if (alive()) notice.value = (error as Error).message;
      } finally {
        sending.value = false;
      }
    };
    return () => (
      <section class="bench-section">
        <div class="bench-head">
          <h2>个人任务</h2>
          <span>{view.value?.devices.filter((item) => item.online).length ?? 0} 台电脑在线</span>
        </div>
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
              <span>资料与成果保存在服务器</span>
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
        {view.value?.devices.map((node) => (
          <div class="rule-row" key={node.name}>
            <div>
              <strong>{node.name}</strong>
              <small>
                {" "}
                {node.agents.map((agent) => (agentNames[agent.use] ?? agent.use) + " · " + agent.id).join("、")}
              </small>
            </div>
            <span>{node.online ? "在线" : "离线"}</span>
          </div>
        ))}
        {view.value?.tasks.length === 0 && <p class="bench-empty">暂无任务。</p>}
        {view.value?.tasks.map((task) => (
          <div class="rule-row" key={task.id}>
            <div>
              <strong>{task.title ?? task.id}</strong>
              <small>
                {" "}
                {task.node} · {task.use ? (agentNames[task.use] ?? task.use) + " · " : ""}
                {task.agent} · {states[task.state] ?? task.state}
              </small>
            </div>
            <button class="word" aria-expanded={chosen.value === task.id} onClick={() => select(task.id)}>
              成果
            </button>
          </div>
        ))}
        {detail.value && (
          <div class="bench-section">
            <div class="bench-head">
              <h3>任务成果</h3>
              <span>{detail.value.cleanup.some((entry) => !entry.cleaned) ? "等待执行机确认清理" : ""}</span>
            </div>
            {detail.value.files.length === 0 && <p class="bench-empty">暂无可下载文件。</p>}
            {detail.value.files.map((file) => (
              <div class="rule-row" key={file.id}>
                <span>{file.name}</span>
                <button
                  class="word"
                  onClick={() => {
                    const task = detail.value!.id;
                    void downloadPersonalFile(task, file.id, file.name).catch((error: Error) => {
                      if (alive()) message.value = error.message;
                    });
                  }}
                >
                  下载
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  },
});
