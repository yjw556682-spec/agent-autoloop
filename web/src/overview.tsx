// The overview: one rail of lines, the plate that blooms above the selected one, the launch control, and the legend.
// A run is a line whose form says its state; an open card is the sodium doublet waiting on you.
import { computed, defineComponent, nextTick, reactive, ref, watch } from "vue";
import { answerCard, cancelRun, emitEvent, fetchWhy, local, resolveCard, type CardView, type RunView } from "./hub";
import { connected, loadError, refresh, state } from "./session";
import { marksOf, type Mark } from "./rail";
import { autoSubject, LaunchHelp } from "./launch-help";
import { timelineOf } from "./why";
import { Operations, Readouts, Workbench, runStatus } from "./workbench";

const marks = computed(() => (state.value ? marksOf(state.value) : []));

const landed = reactive(new Set<string>());
watch(marks, (now, was) => {
  const seen = new Set((was ?? []).map((mark) => mark.key));
  let fresh = false;
  for (const mark of now)
    if (!seen.has(mark.key)) {
      landed.add(mark.key);
      fresh = true;
    }
  if (fresh) setTimeout(() => landed.clear(), 700);
});

type Selected = { kind: "run" | "card"; id: number } | null;
const selected = ref<Selected>(null);
const historyRun = ref<RunView | null>(null);
const detailZone = ref<HTMLElement | null>(null);
const revealDetail = () => void nextTick(() => detailZone.value?.scrollIntoView({ block: "nearest" }));
const railEl = ref<HTMLElement | null>(null);
const pointer = ref(50);
const pointerColor = ref("var(--hair)");
// The waiting card blooms on its own until the person sends it away; a different waiting card earns the attention back.
const dismissed = ref<number | null>(null);

function aim(mark: Mark) {
  const rail = railEl.value;
  const el = rail?.querySelector<HTMLElement>(`[data-key="${mark.key}"]`);
  if (!rail || !el) return;
  const target = Math.max(
    0,
    Math.min(rail.scrollWidth - rail.clientWidth, el.offsetLeft - rail.clientWidth / 2 + el.offsetWidth / 2),
  );
  if (Math.abs(target - rail.scrollLeft) > 24) rail.scrollTo({ left: target, behavior: "smooth" });
}

/* The sodium pointer is measured against the plate it hangs from, once the plate is actually on the screen. */
function placePointer() {
  const rail = railEl.value;
  if (!rail || !selected.value) return;
  const el = rail.querySelector<HTMLElement>(`[data-key="${selected.value.kind}:${selected.value.id}"]`);
  const plate = document.querySelector<HTMLElement>(".plate");
  if (!el || !plate) return;
  const lineCenter = el.getBoundingClientRect().left + el.offsetWidth / 2;
  const share = ((lineCenter - plate.getBoundingClientRect().left) / plate.offsetWidth) * 100;
  pointer.value = Math.min(96, Math.max(4, share));
}

function choose(mark: Mark) {
  selected.value = mark.key.startsWith("card:") ? { kind: "card", id: mark.id } : { kind: "run", id: mark.id };
  if (mark.form === "waiting") dismissed.value = mark.id;
  pointerColor.value = mark.form === "waiting" || mark.form === "notice" ? "var(--sodium)" : "var(--hair)";
  aim(mark);
}

watch(marks, (list) => {
  if (selected.value?.kind === "card" && !list.some((mark) => mark.key === "card:" + selected.value!.id))
    selected.value = null;
  const waiting = list.find((mark) => mark.form === "waiting" && mark.id !== dismissed.value);
  if (waiting && selected.value === null)
    void nextTick(() => {
      if (selected.value === null && marks.value.some((mark) => mark.key === waiting.key)) choose(waiting);
    });
});

const selectedCard = computed(() => {
  if (selected.value?.kind !== "card") return null;
  return state.value?.cards.find((card) => card.id === selected.value!.id) ?? null;
});
const selectedRun = computed(() => {
  if (selected.value?.kind !== "run") return null;
  return (
    state.value?.runs.find((run) => run.id === selected.value!.id) ??
    (historyRun.value?.id === selected.value.id ? historyRun.value : null)
  );
});
watch([selectedCard, selectedRun], () => void nextTick(placePointer), { flush: "post" });

/** The board's one interaction: a click there lands here with the plate already bloomed. */
export function openMarkPlate(key: string) {
  selected.value = key.startsWith("card:")
    ? { kind: "card", id: Number(key.slice(5)) }
    : { kind: "run", id: Number(key.slice(4)) };
  const mark = marks.value.find((one) => one.key === key);
  if (mark) {
    if (mark.form === "waiting") dismissed.value = mark.id;
    pointerColor.value = mark.form === "waiting" || mark.form === "notice" ? "var(--sodium)" : "var(--hair)";
  }
  void nextTick(() => (location.hash = "#/"));
}

/* ---------- answering: the sodium line hands its charge back to the rail ---------- */

const busy = ref(false);
const words = ref("");
const mistake = ref("");
const resolving = ref(false);
const feedback = ref("");
watch(selected, () => {
  words.value = mistake.value = "";
  resolving.value = false;
});

const press = async (card: CardView, body: { choice?: number; text?: string }) => {
  if (busy.value) return;
  busy.value = true;
  mistake.value = "";
  try {
    const result = resolving.value ? await resolveCard(card.id, body.text ?? "") : await answerCard(card.id, body);
    feedback.value = result.changed ? "卡片 #" + card.id + " 已处理。" : "卡片 #" + card.id + " 已在其他地方处理。";
    words.value = "";
    selected.value = null;
    dismissed.value = null;
    await refresh();
  } catch (error) {
    mistake.value = error instanceof Error ? error.message : "没答上，再试一次。";
  }
  busy.value = false;
};

/* ---------- the run's plate: its own facts, told from the log ---------- */

const lines = ref<string[]>([]);
const showing = ref(false);
// Start loading the timeline as soon as its plate opens.
const logError = ref("");
const logLoading = ref(false);
let logRequest = 0;
async function loadTimeline() {
  const ticket = ++logRequest;
  const run = selectedRun.value;
  lines.value = [];
  logError.value = "";
  logLoading.value = Boolean(run);
  if (!run) return;
  try {
    const told = timelineOf(run.id, await fetchWhy(run.id));
    if (ticket === logRequest) lines.value = told;
  } catch {
    if (ticket === logRequest) logError.value = "日志读取失败，请重试。";
  } finally {
    if (ticket === logRequest) logLoading.value = false;
  }
}
watch(
  () => selectedRun.value?.id,
  () => {
    showing.value = false;
    void loadTimeline();
  },
);
watch(
  () => [selectedRun.value?.state, selectedRun.value?.attempts, selectedRun.value?.stopping].join(":"),
  () => {
    if (showing.value) void loadTimeline();
  },
);

const stopping = ref(false);
const stop = async (run: RunView) => {
  if (stopping.value) return;
  stopping.value = true;
  try {
    mistake.value = "";
    await cancelRun(run.id);
    feedback.value = "已提交停止请求 · 第 " + run.id + " 轮。";
    await refresh();
  } catch (error) {
    mistake.value = error instanceof Error ? error.message : "没停成。";
  }
  stopping.value = false;
};

/* ---------- launch ---------- */

// Types the person can pick: the manual door plus whatever the owner's own rules listen for.
// A wildcard pattern like manual.* becomes a concrete default (manual.task) — the protocol
// refuses "*" in a type, and the drop-down hands out real types only.
const supportsEmit = computed(() => !local || (state.value?.lines ?? []).some((line) => line.source === "owner"));
const typeOptions = computed(() => {
  const list = new Set<string>(["manual.task"]);
  for (const line of state.value?.lines ?? [])
    if (line.source === "owner")
      for (const one of line.types) list.add(one.includes("*") ? one.replace(/\*$/, "task") : one);
  return [...list];
});
const typeChoice = ref<string>("manual.task");
const customType = ref("");
const effectiveType = computed(() => (typeChoice.value === "__custom__" ? customType.value.trim() : typeChoice.value));
const subject = ref(autoSubject());
const summary = ref("");
const note = ref("");
const noteBad = ref(false);
const showHelp = ref(false);
const chatLaunch = (chatType: string, chatSubject: string, chatSummary: string) => {
  typeChoice.value = typeOptions.value.includes(chatType) ? chatType : "__custom__";
  if (typeChoice.value === "__custom__") customType.value = chatType;
  subject.value = chatSubject;
  summary.value = chatSummary;
  void launch();
};
const launch = async () => {
  if (!effectiveType.value || busy.value) return;
  busy.value = true;
  noteBad.value = false;
  try {
    const answer = await emitEvent({
      id: crypto.randomUUID?.() ?? `web-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      type: effectiveType.value,
      ...(subject.value.trim() && { subject: subject.value.trim() }),
      ...(summary.value.trim() && { summary: summary.value.trim() }),
    });
    note.value = answer.routed.length
      ? `交给了：${answer.routed.join("、")}`
      : "记下了，还没有规则接它。owner 来源只接 when.source 为 owner 的规则；类型从下拉框里选就一定有规则接。";
    noteBad.value = !answer.routed.length;
    typeChoice.value = typeOptions.value[0] ?? "manual.task";
    customType.value = "";
    subject.value = autoSubject();
    summary.value = "";
    await refresh();
  } catch (error) {
    note.value = error instanceof Error ? error.message : "没发出去。";
    noteBad.value = true;
  }
  busy.value = false;
};

/* ---------- 发射记录: the person's own launched tasks, newest first, one tap to the plate ---------- */

const openRun = (run: RunView) => {
  historyRun.value = run;
  const mark = marks.value.find((one) => one.key === "run:" + run.id);
  if (mark) choose(mark);
  else selected.value = { kind: "run", id: run.id };
  revealDetail();
};
const openCard = (id: number) => {
  const mark = marks.value.find((one) => one.key === "card:" + id);
  if (mark) choose(mark);
  revealDetail();
};

/* ---------- legend ---------- */

const workers = computed(() => {
  const seen = new Map<string, boolean>();
  for (const agent of state.value?.agents ?? [])
    seen.set(agent.worker, (seen.get(agent.worker) ?? false) || agent.online);
  return [...seen];
});
const rules = computed(() =>
  [...new Map(marks.value.filter((mark) => mark.rule).map((mark) => [mark.rule, mark.wl])).entries()].slice(0, 8),
);
const money = (value: number) => `$${value.toFixed(2)}`;

export const Overview = defineComponent({
  setup() {
    return () => {
      const all = state.value;
      const card = selectedCard.value;
      const run = selectedRun.value;
      return (
        <div class={["shell", "console", !connected.value && "lost"]}>
          <header class="bar">
            <a class="brand" href="#/">
              <span aria-hidden="true" class="brand-spectrum" />
              <span class="name">Agent Autoloop</span>
            </a>
            <div class="facts">
              <span>
                <span class={["dot", connected.value ? "on" : "off"]} />
                {connected.value ? "中台在线" : "连不上，重试中"}
              </span>
              {all && (
                <>
                  <a class="board-link" href="#/board">
                    打开大屏 <span aria-hidden="true">↗</span>
                  </a>
                </>
              )}
            </div>
          </header>
          {!connected.value && (
            <div class="banner" role="status">
              与中台断开，正在重连。{all && "当前显示上次状态。"}
            </div>
          )}
          <main class="stage">
            <div class="console-title">
              <h1>运行总览</h1>
              {all && <span>近 7 天 {money(all.spending.week.cost)}</span>}
            </div>
            {all && <Readouts snapshot={all} />}
            {!all && (
              <p class="bench-empty" role="status">
                {loadError.value || "正在读取中台…"}
              </p>
            )}
            <section class="spectrum-panel" aria-label="运行谱线">
              <div class="spectrum-head">
                <h2>运行谱线</h2>
                <div>
                  <span>实线 · 进行中</span>
                  <span>短线 · 历史</span>
                  <span class="legend-attention">双线 · 待回复</span>
                </div>
              </div>
              <div ref={detailZone} class={["plate-zone", !(card || run || showHelp.value) && "plate-empty"]}>
                {card && (
                  <div
                    class="plate"
                    style={{ "--pointer": `${pointer.value}%`, "--pointer-color": "var(--sodium)" } as any}
                  >
                    <div class="head">
                      <span class="num">
                        卡片 #{card.id} · {card.kind === "ask" ? "等你决定" : "要你留意"}
                      </span>
                      <span class="sub">{card.rule}</span>
                    </div>
                    <div class="body">
                      <strong>{card.title}</strong>
                      {card.text && card.text !== card.title && <div>{card.text}</div>}
                    </div>
                    {card.kind === "ask" && !resolving.value && (
                      <div class="options">
                        {card.options.map((option, index) => (
                          <button
                            class={["act", card.recommend === index && "best", busy.value && "busy"]}
                            disabled={busy.value}
                            onClick={() => press(card, { choice: index })}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    )}
                    <div class="other">
                      <input
                        class="word"
                        placeholder={
                          resolving.value
                            ? "结案原因（必填）"
                            : card.kind === "ask"
                              ? "输入其他回复"
                              : "处理说明（选填）"
                        }
                        aria-label={resolving.value ? "结案原因" : card.kind === "ask" ? "别的想法" : "处理说明"}
                        value={words.value}
                        onInput={(event) => (words.value = (event.target as HTMLInputElement).value)}
                        onKeydown={(event) =>
                          event.key === "Enter" &&
                          ((!resolving.value && card.kind === "notice") || words.value.trim() !== "") &&
                          press(card, words.value.trim() ? { text: words.value.trim() } : {})
                        }
                      />
                      <button
                        class={["act", busy.value && "busy"]}
                        disabled={busy.value}
                        onClick={() =>
                          ((!resolving.value && card.kind === "notice") || words.value.trim() !== "") &&
                          press(card, words.value.trim() ? { text: words.value.trim() } : {})
                        }
                      >
                        {resolving.value ? "确认结案" : card.kind === "ask" ? "发送" : "记录并结案"}
                      </button>
                    </div>
                    <div class="other">
                      {card.kind === "ask" && (
                        <button
                          class="act quiet"
                          disabled={busy.value}
                          onClick={() => {
                            resolving.value = !resolving.value;
                            words.value = mistake.value = "";
                          }}
                        >
                          {resolving.value ? "返回回复" : "填写原因并结案"}
                        </button>
                      )}
                      <button class="act quiet" disabled={busy.value} onClick={() => (selected.value = null)}>
                        收起
                      </button>
                    </div>
                    {mistake.value && (
                      <div class="mistake" role="alert">
                        {mistake.value}
                      </div>
                    )}
                  </div>
                )}
                {run && (
                  <div
                    class="plate"
                    style={{ "--pointer": `${pointer.value}%`, "--pointer-color": pointerColor.value } as any}
                  >
                    <div class="head">
                      <span class="num">第 {run.id} 轮</span>
                      <span class="sub">
                        {run.rule} · {runStatus(run)}
                      </span>
                    </div>
                    {(run.summary || run.error) && <div class="body">{run.summary || run.error}</div>}
                    <div class="meta">
                      <span>
                        Agent <b>{run.agent}</b>
                      </span>
                      {run.usage && (
                        <span>
                          用量{" "}
                          <b>
                            {((run.usage.input ?? 0) + (run.usage.output ?? 0)).toLocaleString()} token ·{" "}
                            {money(run.usage.cost ?? 0)}
                          </b>
                        </span>
                      )}
                      {run.state === "queued" && run.attempts > 0 && (
                        <span>
                          第 {run.attempts + 1} 次尝试，{new Date(run.notBefore).toLocaleString()} 再来
                        </span>
                      )}
                    </div>
                    {run.events.length > 0 && (
                      <div class="meta" style={{ flexDirection: "column", gap: "2px", alignItems: "flex-start" }}>
                        {run.events.map((event) => (
                          <span>
                            {event.type}
                            {event.subject && ` · ${event.subject}`}
                            {event.summary && ` · ${event.summary}`}
                          </span>
                        ))}
                      </div>
                    )}
                    <div class="other">
                      {!run.stopping && ["queued", "claimed", "unknown"].includes(run.state) && (
                        <button class="act quiet" disabled={stopping.value} onClick={() => stop(run)}>
                          {stopping.value ? "正在停…" : "停这一轮"}
                        </button>
                      )}
                      <button class="act quiet" onClick={() => (showing.value = !showing.value)}>
                        {showing.value ? "收起经过" : "看经过"}
                      </button>
                      <button
                        class="act quiet"
                        onClick={() => {
                          selected.value = null;
                          feedback.value = "";
                        }}
                      >
                        收起
                      </button>
                    </div>
                    {mistake.value && (
                      <div class="mistake" role="alert">
                        {mistake.value}
                      </div>
                    )}
                    {showing.value && (
                      <div class="tline">
                        {logError.value ? (
                          <button class="act quiet" onClick={loadTimeline}>
                            {logError.value}
                          </button>
                        ) : lines.value.length ? (
                          lines.value.map((line) => {
                            const at = line.indexOf("  ");
                            return (
                              <div>
                                <span class="t">{line.slice(0, at)}</span>
                                {line.slice(at)}
                              </div>
                            );
                          })
                        ) : (
                          <span>{logLoading.value ? "正在读取经过…" : "这轮暂时没有可显示的经过。"}</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {showHelp.value && <LaunchHelp options={typeOptions.value} onLaunch={chatLaunch} />}
              </div>
              {all && marks.value.length === 0 && <p class="bench-empty spectrum-empty">还没有运行记录。</p>}
              <div class="rail-wrap">
                <div class="rail" ref={railEl}>
                  {marks.value.map((mark) => (
                    <button
                      key={mark.key}
                      data-key={mark.key}
                      class={[
                        "rail-line",
                        selected.value && `${selected.value.kind}:${selected.value.id}` === mark.key && "selected",
                      ]}
                      title={mark.title}
                      aria-label={`${mark.rule} ${mark.label} ${mark.title !== mark.rule ? mark.title : ""}`}
                      onClick={() => choose(mark)}
                    >
                      <span class="stem-slot">
                        <span
                          class={["stem", mark.form, landed.has(mark.key) && "land"]}
                          style={{ "--wl": mark.wl } as any}
                        />
                        {mark.form === "waiting" && <span class="stem waiting" aria-hidden="true" />}
                      </span>
                      <span class="rail-tag">{mark.label}</span>
                    </button>
                  ))}
                </div>
                <div class="baseline" />
              </div>
            </section>
            {feedback.value && (
              <p class="bench-feedback" role="status">
                {feedback.value}
              </p>
            )}
            {all && (
              <Workbench
                snapshot={all}
                selected={selected.value ? selected.value.kind + ":" + selected.value.id : ""}
                openRun={openRun}
                openCard={openCard}
              />
            )}
            {all && <Operations snapshot={all} />}
            {supportsEmit.value && (
              <div class="launch">
                <select
                  class="word type"
                  value={typeChoice.value}
                  aria-label="事件类型"
                  onChange={(event) => (typeChoice.value = (event.target as HTMLSelectElement).value)}
                >
                  {typeOptions.value.map((one) => (
                    <option value={one}>{one}</option>
                  ))}
                  <option value="__custom__">自定义…</option>
                </select>
                {typeChoice.value === "__custom__" && (
                  <input
                    class="word type"
                    placeholder="manual.你的类型"
                    aria-label="自定义事件类型"
                    value={customType.value}
                    onInput={(event) => (customType.value = (event.target as HTMLInputElement).value)}
                    onKeydown={(event) => event.key === "Enter" && launch()}
                  />
                )}
                <input
                  class="word"
                  style={{ flex: "0 1 170px" }}
                  placeholder="对象 #编号"
                  aria-label="对象"
                  value={subject.value}
                  onInput={(event) => (subject.value = (event.target as HTMLInputElement).value)}
                  onKeydown={(event) => event.key === "Enter" && launch()}
                />
                <input
                  class="word sum"
                  placeholder="要让 Agent 做什么？一句话说清"
                  aria-label="一句话说明"
                  value={summary.value}
                  onInput={(event) => (summary.value = (event.target as HTMLInputElement).value)}
                  onKeydown={(event) => event.key === "Enter" && launch()}
                />
                <button
                  class={["act", "quiet", showHelp.value && "best-quiet"]}
                  onClick={() => (showHelp.value = !showHelp.value)}
                >
                  {showHelp.value ? "收起指导" : "怎么填？"}
                </button>
                <button class={["act", "best", busy.value && "busy"]} onClick={launch}>
                  发射
                </button>
                <span class={["note", noteBad.value && "err"]} role="status">
                  {note.value}
                </span>
              </div>
            )}
          </main>
          <footer class="legend">
            <div class="key">
              {rules.value.map(([name, wl]) => (
                <span class="tick">
                  <span class="swatch" style={{ background: wl }} />
                  {name}
                </span>
              ))}
            </div>
            {all && (
              <>
                {/* The separator rides with the usage item, so small screens reordering it take the pipe along. */}
                <span class="usage">
                  今日 {money(all.spending.today.cost)} · {all.spending.today.tokens.toLocaleString()} token
                </span>
                {all.unrouted.length > 0 && (
                  <>
                    <span class="gap">|</span>
                    <span class="tick">
                      <span
                        class="swatch"
                        style={{
                          background: "repeating-linear-gradient(90deg, var(--sodium) 0 4px, transparent 4px 7px)",
                        }}
                      />
                      {all.unrouted.length} 条事件没被接走
                    </span>
                  </>
                )}
                <span class="gap">|</span>
                <span>
                  {workers.value.filter(([, online]) => online).length}/{workers.value.length} 接单程序在线
                </span>
              </>
            )}
          </footer>
        </div>
      );
    };
  },
});
