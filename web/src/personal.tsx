import { defineComponent, onMounted, onUnmounted, ref } from "vue";
import { downloadPersonalFile, fetchPersonalTask, fetchPersonalTasks, key, type PersonalDetails } from "./hub";

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

export const Personal = defineComponent({
  setup() {
    const view = ref<Awaited<ReturnType<typeof fetchPersonalTasks>>>();
    const detail = ref<PersonalDetails>();
    const chosen = ref("");
    const message = ref("");
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
    return () => (
      <section class="bench-section">
        <div class="bench-head">
          <h2>个人任务</h2>
          <span>{view.value?.devices.filter((item) => item.online).length ?? 0} 台电脑在线</span>
        </div>
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
