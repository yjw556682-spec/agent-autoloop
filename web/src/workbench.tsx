import { computed, defineComponent, ref, type PropType } from "vue";
import { controlRule, fetchState, local, submitBootcamp, type LineView, type RunView, type State } from "./hub";
import { refresh } from "./session";
import { wavelength } from "./wave";

const states: Record<RunView["state"], string> = {
  queued: "排队",
  claimed: "运行中",
  unknown: "待核查",
  done: "已完成",
  nothing: "无需处理",
  cancelled: "已停止",
};
export const runStatus = (run: RunView) =>
  run.stopping ? "正在停止" : run.state === "queued" && run.attempts > 0 ? "等重试" : (states[run.state] ?? run.state);
const date = (value: string) => {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? value
    : at.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
};
const runText = (run: RunView) => {
  const event = run.events.find((one) => one.summary || one.subject);
  return run.summary || run.error || event?.summary || event?.subject || run.agent;
};

export const Readouts = defineComponent({
  props: { snapshot: { type: Object as PropType<State>, required: true } },
  setup(props) {
    return () => {
      const { cards, totals, spending } = props.snapshot;
      const readouts = [
        { label: "待你处理", count: cards.length, style: cards.length ? "attention" : "" },
        { label: "运行中", count: totals.running, style: totals.running ? "running" : "" },
        { label: "排队及重试", count: totals.queued, style: "" },
        { label: "今日完成", count: totals.doneToday, style: totals.doneToday ? "complete" : "" },
      ];
      return (
        <div class="readouts">
          {readouts.map(({ label, count, style }) => (
            <div key={label} class={["readout", style]}>
              <span>{label}</span>
              <strong>{count}</strong>
            </div>
          ))}
          <div class="readout usage-readout">
            <span>今日用量</span>
            <strong>{"$" + spending.today.cost.toFixed(2)}</strong>
            <small>{spending.today.tokens.toLocaleString()} token</small>
          </div>
        </div>
      );
    };
  },
});

export const Workbench = defineComponent({
  props: {
    snapshot: { type: Object as PropType<State>, required: true },
    selected: String,
    openRun: { type: Function as PropType<(run: RunView) => void>, required: true },
    openCard: { type: Function as PropType<(id: number) => void>, required: true },
  },
  setup(props) {
    const filter = ref("all");
    const older = ref<RunView[]>([]);
    const cursor = ref<number | null>(null);
    const loaded = ref(false);
    const loading = ref(false);
    const issue = ref("");
    const rows = computed(() =>
      [...new Map([...older.value, ...props.snapshot.runs].map((run) => [run.id, run])).values()].sort(
        (a, b) => b.id - a.id,
      ),
    );
    const visible = computed(() =>
      rows.value.filter(
        (run) =>
          filter.value === "all" ||
          (filter.value === "active"
            ? ["queued", "claimed", "unknown"].includes(run.state)
            : ["done", "nothing", "cancelled"].includes(run.state)),
      ),
    );
    const more = async () => {
      const before = loaded.value ? cursor.value : props.snapshot.nextBefore;
      if (!before || loading.value) return;
      loading.value = true;
      issue.value = "";
      try {
        const page = await fetchState(before);
        older.value.push(...page.runs);
        cursor.value = page.nextBefore;
        loaded.value = true;
      } catch (error) {
        issue.value = (error as Error).message;
      } finally {
        loading.value = false;
      }
    };
    return () => {
      const all = props.snapshot;
      return (
        <div class="workbench-columns">
          <section class="bench-section">
            <div class="bench-head">
              <h2>运行记录</h2>
              <div class="bench-tabs" role="group" aria-label="筛选运行">
                {[
                  ["all", "全部"],
                  ["active", "进行中"],
                  ["finished", "已结束"],
                ].map(([id, label]) => (
                  <button key={id} aria-pressed={filter.value === id} onClick={() => (filter.value = id)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div class="bench-list">
              {visible.value.slice(0, loaded.value ? undefined : 6).map((run) => (
                <button
                  key={run.id}
                  class="run-row"
                  aria-pressed={props.selected === "run:" + run.id}
                  onClick={() => props.openRun(run)}
                >
                  <span class="row-spectrum" style={{ background: wavelength(run.rule) }} />
                  <span class="row-info">
                    <strong>{run.rule}</strong>
                    <span title={runText(run)}>{runText(run)}</span>
                  </span>
                  <span class="row-time">
                    #{run.id} · {date(run.createdAt)}
                  </span>
                  <span class={["row-status", "status-" + run.state]}>{runStatus(run)}</span>
                </button>
              ))}
              {visible.value.length === 0 && (
                <p class="bench-empty">
                  当前没有{filter.value === "all" ? "" : filter.value === "active" ? "进行中的" : "已结束的"}运行。
                </p>
              )}
            </div>
            {((!loaded.value && visible.value.length > 6) || (loaded.value ? cursor.value !== null : all.hasMore)) && (
              <button
                class="bench-more"
                disabled={loading.value}
                onClick={() => {
                  if (!loaded.value && visible.value.length > 6) {
                    loaded.value = true;
                    cursor.value = all.nextBefore;
                  } else void more();
                }}
              >
                {loading.value ? "读取中…" : "查看更多"}
              </button>
            )}
            {issue.value && (
              <p class="bench-feedback failure" role="alert">
                {issue.value}
              </p>
            )}
          </section>

          <aside class="bench-side">
            <section class="bench-section">
              <div class="bench-head">
                <h2>待你处理</h2>
                <span class={all.cards.length ? "hot-count" : ""}>{all.cards.length}</span>
              </div>
              {all.cards.length === 0 && <p class="bench-empty">没有待回复或待结案的卡片。</p>}
              {all.cards.map((card) => (
                <button
                  key={card.id}
                  class="pending-row"
                  aria-pressed={props.selected === "card:" + card.id}
                  onClick={() => props.openCard(card.id)}
                >
                  <span aria-hidden="true" class="pending-mark" />
                  <span class="row-info">
                    <strong>{card.title}</strong>
                    <span>
                      {card.rule} · #{card.id}
                    </span>
                  </span>
                  <span>{card.kind === "ask" ? "待回复" : "待结案"}</span>
                </button>
              ))}
            </section>
            <section class="bench-section">
              <div class="bench-head">
                <h2>连接</h2>
                <span>
                  {all.agents.filter((one) => one.online).length + all.channels.filter((one) => one.online).length}/
                  {all.agents.length + all.channels.length} 在线
                </span>
              </div>
              <div class="connection-list">
                {[
                  ...all.agents.map((one) => ({ ...one, role: "执行器" })),
                  ...all.channels.map((one) => ({ ...one, role: "通知" })),
                ].map((one) => (
                  <div class="connection" key={one.role + one.id}>
                    <span>
                      <span class={["dot", one.online ? "on" : "off"]} />
                      {one.name || one.id}
                    </span>
                    <span>
                      {one.role} · {one.online ? "在线" : "离线"}
                    </span>
                  </div>
                ))}
                {all.agents.length + all.channels.length === 0 && <p class="bench-empty">尚未配置执行器或通知。</p>}
              </div>
            </section>
          </aside>
        </div>
      );
    };
  },
});

const isBootcampRule = (line: LineView) => local?.bootcamp && line.types.includes("bootcamp.draft.requested");

export const Operations = defineComponent({
  props: { snapshot: { type: Object as PropType<State>, required: true } },
  setup(props) {
    const sending = ref(false);
    const bootcampRule = computed(() => props.snapshot.lines.find(isBootcampRule));
    const link = ref("");
    const plan = ref("");
    const message = ref("");
    const bad = ref(false);
    const action = ref<{ line: LineView; kind: "run" | "pause" | "resume" | "replay" } | null>(null);
    const replay = ref<{ line: LineView; count: number } | null>(null);
    const reason = ref("");
    const until = ref("");
    const subject = ref("");
    const labels = { run: "立即运行", pause: "暂停", resume: "恢复", replay: "补跑跳过的事件" };
    const submit = async () => {
      if (!link.value.trim() || sending.value) return;
      sending.value = true;
      message.value = "";
      try {
        message.value = (await submitBootcamp(link.value.trim(), plan.value.trim())).message;
        bad.value = false;
        link.value = plan.value = "";
        await refresh();
      } catch (error) {
        message.value = (error as Error).message;
        bad.value = true;
      } finally {
        sending.value = false;
      }
    };
    const chooseAction = (line: LineView, kind: NonNullable<typeof action.value>["kind"]) => {
      action.value = { line, kind };
      message.value = reason.value = subject.value = until.value = "";
    };
    const apply = async () => {
      if (!action.value || sending.value) return;
      const { line, kind } = action.value;
      sending.value = true;
      message.value = "";
      try {
        const result = await controlRule(
          line.name,
          kind,
          kind === "replay"
            ? { since: line.paused?.since }
            : kind === "pause"
              ? {
                  ...(reason.value.trim() && { reason: reason.value.trim() }),
                  ...(until.value && { until: new Date(until.value).toISOString() }),
                }
              : kind === "run"
                ? {
                    ...(subject.value.trim() && { subject: subject.value.trim() }),
                    ...(reason.value.trim() && { reason: reason.value.trim() }),
                  }
                : {},
        );
        if (kind === "resume" && result.paused?.skipped?.count) {
          replay.value = { line: { ...line, paused: result.paused }, count: result.paused.skipped.count };
        }
        if (kind === "replay") replay.value = null;
        message.value = result.run
          ? "已排队 · 第 " + result.run + " 轮"
          : result.runs
            ? "已安排 " + result.runs.length + " 轮补跑"
            : labels[kind] + "已提交。";
        bad.value = false;
        action.value = null;
        await refresh();
      } catch (error) {
        message.value = (error as Error).message;
        bad.value = true;
      } finally {
        sending.value = false;
      }
    };
    return () => (
      <div class="operations">
        {bootcampRule.value && (
          <section class="bench-section bootcamp">
            <div class="bench-head">
              <h2>提交高校实训营</h2>
              <span>{bootcampRule.value.paused ? "规则已暂停" : "本地草稿待审核"}</span>
            </div>
            <div class="operation-fields">
              <label>
                飞书任务或方案链接
                <input
                  class="word"
                  type="url"
                  value={link.value}
                  placeholder="https://…"
                  onInput={(event) => (link.value = (event.target as HTMLInputElement).value)}
                />
              </label>
              <label>
                指定方案链接 <small>任务有多份方案时填写</small>
                <input
                  class="word"
                  type="url"
                  value={plan.value}
                  placeholder="https://…"
                  onInput={(event) => (plan.value = (event.target as HTMLInputElement).value)}
                />
              </label>
              <button
                class="act best"
                disabled={sending.value || Boolean(bootcampRule.value.paused) || !link.value.trim()}
                onClick={submit}
              >
                {sending.value && !action.value ? "提交中…" : "提交草稿任务"}
              </button>
            </div>
          </section>
        )}
        <section class="bench-section rules-list">
          <div class="bench-head">
            <h2>规则与来源</h2>
            <span>{props.snapshot.lines.length} 条规则</span>
          </div>
          {props.snapshot.lines.length === 0 && <p class="bench-empty">还没有配置规则。</p>}
          {props.snapshot.lines.map((line) => (
            <div class="rule-row" key={line.id}>
              <span class="row-info">
                <strong>
                  <span class="row-spectrum" style={{ background: wavelength(line.name) }} />
                  {line.name}
                </strong>
                <span>
                  {line.every
                    ? line.every + (line.next && !line.paused ? " · 下次 " + date(line.next) : "")
                    : [line.source, ...line.types].filter(Boolean).join(" · ")}
                </span>
              </span>
              {line.paused && <span class="rule-paused">已暂停{line.paused.reason && " · " + line.paused.reason}</span>}
              <div class="rule-actions">
                {!line.paused && !isBootcampRule(line) && (
                  <button class="act quiet" disabled={sending.value} onClick={() => chooseAction(line, "run")}>
                    立即运行
                  </button>
                )}
                {isBootcampRule(line) && !line.paused && <span class="rule-paused">通过飞书链接提交</span>}
                <button
                  class="act quiet"
                  disabled={sending.value}
                  onClick={() => chooseAction(line, line.paused ? "resume" : "pause")}
                >
                  {line.paused ? "恢复" : "暂停"}
                </button>
              </div>
            </div>
          ))}
          {props.snapshot.sources?.length ||
          props.snapshot.timers?.length ||
          props.snapshot.elsewhere?.length ||
          props.snapshot.unrouted.length ? (
            <div class="source-list">
              {props.snapshot.sources?.map((source) => (
                <span key={source.id}>
                  {source.name || source.id} · {source.events} 条事件
                </span>
              ))}
              {props.snapshot.unrouted.length > 0 && <span>{props.snapshot.unrouted.length} 条近期事件未路由</span>}
              {props.snapshot.timers?.map((timer) => (
                <span key={timer.rule + ":" + timer.key}>
                  {timer.rule} · 复查 {date(timer.at)}
                </span>
              ))}
              {props.snapshot.elsewhere?.map((item) => (
                <span key={item.name}>
                  {item.name} · 在 {item.where} 运行 · {date(item.next)}
                </span>
              ))}
            </div>
          ) : null}
          {replay.value && !action.value && (
            <div class="rule-confirm">
              <strong>
                「{replay.value.line.name}」暂停期间跳过了 {replay.value.count} 条事件
              </strong>
              <button
                class="act quiet"
                disabled={sending.value}
                onClick={() => chooseAction(replay.value!.line, "replay")}
              >
                查看补跑操作
              </button>
              <button class="act quiet" disabled={sending.value} onClick={() => (replay.value = null)}>
                收起
              </button>
            </div>
          )}
          {action.value && (
            <div class="rule-confirm">
              <strong>
                {labels[action.value.kind]}「{action.value.line.name}」
              </strong>
              {action.value.kind === "run" && (
                <label>
                  对象（选填）
                  <input
                    class="word"
                    value={subject.value}
                    onInput={(event) => (subject.value = (event.target as HTMLInputElement).value)}
                  />
                </label>
              )}
              {["pause", "run"].includes(action.value.kind) && (
                <label>
                  说明（选填）
                  <input
                    class="word"
                    value={reason.value}
                    onInput={(event) => (reason.value = (event.target as HTMLInputElement).value)}
                  />
                </label>
              )}
              {action.value.kind === "pause" && (
                <label>
                  恢复时间（选填）
                  <input
                    class="word"
                    type="datetime-local"
                    value={until.value}
                    onInput={(event) => (until.value = (event.target as HTMLInputElement).value)}
                  />
                </label>
              )}
              <div class="rule-actions">
                <button class="act best" disabled={sending.value} onClick={apply}>
                  {sending.value ? "提交中…" : "确认"}
                </button>
                <button class="act quiet" disabled={sending.value} onClick={() => (action.value = null)}>
                  取消
                </button>
              </div>
            </div>
          )}
          {message.value && (
            <p class={["bench-feedback", bad.value && "failure"]} role={bad.value ? "alert" : "status"}>
              {message.value}
            </p>
          )}
        </section>
      </div>
    );
  },
});
