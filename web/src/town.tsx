import { computed, defineComponent, ref, type PropType } from "vue";
import type { RunView, State } from "./hub";
import { connected } from "./session";
import { runStatus } from "./run-status";

const places = [
  { id: "dispatch", name: "派单站", icon: "▤" },
  { id: "hall", name: "议事厅", icon: "!" },
  { id: "studio", name: "工坊", icon: "⚒" },
  { id: "archive", name: "档案馆", icon: "▧" },
  { id: "lighthouse", name: "灯塔", icon: "✦" },
] as const;
type Place = (typeof places)[number]["id"];
type Agent = State["agents"][number];
const adapters = [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["acp", "ACP"],
  ["dsh", "DeepSeek Harness"],
  ["command", "通用命令"],
  ["zcode", "ZCode"],
] as const;
const adapterNames: Record<string, string> = Object.fromEntries(adapters);
const number = (value: number) => value.toLocaleString("zh-CN");
const when = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";
const agentAdapter = (agent: Agent) => (agent.use ? adapterNames[agent.use] || agent.use : agent.worker);

function goTo(id: string) {
  const section = document.getElementById(id);
  section?.focus({ preventScroll: true });
  section?.scrollIntoView({ block: "start" });
}

export const Town = defineComponent({
  props: {
    snapshot: { type: Object as PropType<State>, required: true },
    openRun: { type: Function as PropType<(run: RunView) => void>, required: true },
    openCard: { type: Function as PropType<(id: number) => void>, required: true },
    manualIntake: Boolean,
    bootcampIntake: Boolean,
  },
  setup(props) {
    const active = ref<Place>("dispatch");
    const runs = computed(() => props.snapshot.runs);
    const agents = computed(() => new Map(props.snapshot.agents.map((agent) => [agent.id, agent])));
    const sources = computed(() => new Map((props.snapshot.sources ?? []).map((source) => [source.id, source.name])));
    const jobs = computed(() => runs.value.filter((run) => ["queued", "claimed", "unknown"].includes(run.state)));
    const latest = computed(() => runs.value.filter((run) => ["done", "cancelled", "nothing"].includes(run.state)));
    const activePlace = computed(() => places.find((place) => place.id === active.value)!);
    function choosePlace(place: Place) {
      active.value = place;
      if (window.matchMedia("(max-width: 850px)").matches) goTo("town-inspector");
    }
    const agentName = (id: string) => agents.value.get(id)?.name || id;
    const jobRow = (run: RunView, route: boolean) => {
      const event = run.events[0];
      return (
        <button key={run.id} class="town-row town-row-button" onClick={() => props.openRun(run)}>
          <span class="town-row-copy">
            <strong>{run.rule}</strong>
            <small>
              {route && event
                ? (sources.value.get(event.source) ?? event.source) + " → " + agentName(run.agent)
                : agentName(run.agent) + " · #" + run.id}
            </small>
          </span>
          <span class={["town-tag", "town-" + run.state]}>{runStatus(run)}</span>
        </button>
      );
    };
    return () => {
      const all = props.snapshot;
      const online = all.agents.filter((agent) => agent.online).length;
      const channels = all.channels.filter((channel) => channel.online).length;
      const recentlyUnrouted = all.unrouted.length;
      const counts: Record<Place, string> = {
        dispatch: number(all.totals.queued + all.totals.running + all.totals.unknown),
        hall: number(all.cards.length),
        studio: connected.value ? online + "/" + all.agents.length : "–",
        archive: number(all.totals.doneToday),
        lighthouse: connected.value ? channels + "/" + all.channels.length : "–",
      };
      const headings: Record<Place, string> = {
        dispatch: "任务队列与规则",
        hall: "等你处理的事项",
        studio: "Agent 接入与运行",
        archive: "最近结束的任务",
        lighthouse: "通知通道",
      };
      return (
        <section class="town" aria-label="任务小镇">
          <div class="town-layout">
            <div class="town-map" role="group" aria-label="小镇地图，选择建筑查看任务">
              <div class="town-map-title">
                <span class={["town-live", connected.value && "up"]} />
                {connected.value ? "中台在线" : "正在重连"}
              </div>
              <div
                class={["town-courier", connected.value && all.totals.running > 0 && "walking"]}
                aria-hidden="true"
              />
              <div class="town-residents" aria-hidden="true">
                {all.agents.slice(0, 4).map((agent) => (
                  <span key={agent.id} class={["agent-sprite", agent.online && connected.value && "awake"]} />
                ))}
              </div>
              {places.map((place) => (
                <button
                  key={place.id}
                  class={["town-pin", "pin-" + place.id, place.id === "hall" && all.cards.length > 0 && "urgent"]}
                  aria-pressed={place.id === active.value}
                  aria-controls="town-inspector"
                  aria-label={place.name + " · " + counts[place.id]}
                  onClick={() => choosePlace(place.id)}
                >
                  <span aria-hidden="true" class="pin-icon">
                    {place.icon}
                  </span>
                  <span class="pin-name">{place.name}</span>
                  <strong class="pin-count">{counts[place.id]}</strong>
                </button>
              ))}
            </div>
            <div class="town-inspector" id="town-inspector" tabindex="-1" aria-label="建筑详情">
              <div class="town-inspector-head">
                <span class={"place-icon place-" + active.value} aria-hidden="true">
                  {activePlace.value.icon}
                </span>
                <div>
                  <h2>{activePlace.value.name}</h2>
                  <p>{headings[active.value]}</p>
                </div>
              </div>
              <div class="town-inspector-body">
                {active.value === "dispatch" && (
                  <>
                    <div class="town-section-title">
                      <h3>分发队列</h3>
                      <span>
                        {all.totals.queued} 排队 · {all.totals.running} 运行中
                        {all.totals.unknown ? " · " + all.totals.unknown + " 待核查" : ""}
                      </span>
                    </div>
                    {jobs.value.length === 0 && <p class="town-empty">当前没有待分发或运行中的任务。</p>}
                    {jobs.value.slice(0, 4).map((run) => jobRow(run, true))}
                    {recentlyUnrouted > 0 && <p class="town-warning">{recentlyUnrouted} 条近期事件未匹配规则。</p>}
                    <div class="town-section-title">
                      <h3>分发规则</h3>
                      <span>{all.lines.length} 条</span>
                    </div>
                    {all.lines.length === 0 && <p class="town-empty">尚未配置规则。</p>}
                    {all.lines.slice(0, 4).map((rule) => (
                      <div class="town-row" key={rule.id}>
                        <span class="town-row-copy">
                          <strong>{rule.name}</strong>
                          <small title={rule.every || rule.types.join("、")}>
                            {rule.every ? "定时" : (sources.value.get(rule.source ?? "") ?? rule.source ?? "事件")} →{" "}
                            {agentName(rule.agent)}
                          </small>
                        </span>
                        <span class="town-tag">{rule.paused ? "已暂停" : "生效中"}</span>
                      </div>
                    ))}
                  </>
                )}
                {active.value === "hall" && (
                  <>
                    <div class="town-section-title">
                      <h3>卡片</h3>
                      <span>{all.cards.length} 张</span>
                    </div>
                    {all.cards.length === 0 && <p class="town-empty">当前没有待回复或待结案的卡片。</p>}
                    {all.cards.map((card) => (
                      <button key={card.id} class="town-row town-row-button" onClick={() => props.openCard(card.id)}>
                        <span class="town-row-copy">
                          <strong>{card.title}</strong>
                          <small>
                            {card.rule} · #{card.id}
                          </small>
                        </span>
                        <span class="town-tag town-pending">{card.kind === "ask" ? "回复" : "结案"}</span>
                      </button>
                    ))}
                  </>
                )}
                {active.value === "studio" && (
                  <>
                    <div class="town-section-title">
                      <h3>执行器</h3>
                      <span>{connected.value ? online + " 在线" : "上次状态"}</span>
                    </div>
                    {all.agents.length === 0 && <p class="town-empty">尚未接入执行器。</p>}
                    {all.agents.map((agent) => (
                      <div class="town-row" key={agent.id}>
                        <span class={["agent-sprite", agent.online && connected.value && "awake"]} aria-hidden="true" />
                        <span class="town-row-copy">
                          <strong>{agent.name || agent.id}</strong>
                          <small>
                            {agentAdapter(agent)} ·{" "}
                            {jobs.value.filter((run) => run.agent === agent.id && run.state === "claimed").length}{" "}
                            项运行中
                          </small>
                        </span>
                        <span class={["town-tag", agent.online && connected.value && "town-ok"]}>
                          {connected.value ? (agent.online ? "在线" : "离线") : "待刷新"}
                        </span>
                      </div>
                    ))}
                    <div class="town-section-title">
                      <h3>接入方式</h3>
                      <span>配置与接入参考</span>
                    </div>
                    <div class="town-adapters">
                      {adapters.map(([use, label]) => (
                        <div key={use}>
                          <span>{label}</span>
                          <small>
                            {all.agents.some((agent) => agent.use === use)
                              ? "已配置"
                              : use === "zcode"
                                ? "需核对中台版本"
                                : "需安装并验证"}
                          </small>
                        </div>
                      ))}
                    </div>
                    <p class="town-empty">在线表示接单程序已连接。模型登录和实际执行以试跑结果为准。</p>
                  </>
                )}
                {active.value === "archive" && (
                  <>
                    <div class="town-section-title">
                      <h3>运行记录</h3>
                      <span>今日完成 {all.totals.doneToday} 轮</span>
                    </div>
                    {latest.value.length === 0 && <p class="town-empty">还没有结束的任务。</p>}
                    {latest.value.slice(0, 7).map((run) => jobRow(run, false))}
                  </>
                )}
                {active.value === "lighthouse" && (
                  <>
                    <div class="town-section-title">
                      <h3>已配置通道</h3>
                      <span>{connected.value ? channels + " 在线" : "上次状态"}</span>
                    </div>
                    {all.channels.length === 0 && <p class="town-empty">尚未配置通知通道。</p>}
                    {all.channels.map((channel) => (
                      <div class="town-row" key={channel.id}>
                        <span class="town-row-copy">
                          <strong>{channel.name}</strong>
                          {channel.seenAt && <small>最近连接 {when(channel.seenAt)}</small>}
                        </span>
                        <span class={["town-tag", channel.online && connected.value && "town-ok"]}>
                          {connected.value ? (channel.online ? "在线" : "离线") : "待刷新"}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
              {active.value !== "hall" && (
                <div class="town-actions">
                  {active.value === "dispatch" && (
                    <>
                      {(props.bootcampIntake || props.manualIntake) && (
                        <button
                          class="town-primary"
                          onClick={() => goTo(props.bootcampIntake ? "task-submit" : "manual-event")}
                        >
                          提交任务
                        </button>
                      )}
                      <button onClick={() => goTo("rule-routing")}>管理规则</button>
                    </>
                  )}
                  {active.value === "archive" && <button onClick={() => goTo("run-history")}>查看全部记录</button>}
                  {active.value === "studio" && (
                    <a
                      href="https://github.com/KKKKhazix/agent-autoloop/blob/v1.8.2/docs/plugins.md"
                      target="_blank"
                      rel="noreferrer"
                    >
                      接入文档 ↗
                    </a>
                  )}
                  {active.value === "lighthouse" && <button onClick={() => goTo("connection-state")}>查看连接</button>}
                </div>
              )}
            </div>
          </div>
        </section>
      );
    };
  },
});
