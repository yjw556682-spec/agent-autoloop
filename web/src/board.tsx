// The large display shares the overview's rail. Selecting a line opens its detail in the overview.
import { computed, defineComponent } from "vue";
import { connected, state } from "./session";
import { marksOf } from "./rail";
import { openMarkPlate } from "./overview";
import { Readouts } from "./workbench";

const marks = computed(() => (state.value ? marksOf(state.value) : []));
const money = (value: number) => `$${value.toFixed(2)}`;

export const Board = defineComponent({
  setup() {
    return () => {
      const all = state.value;
      const waiting = all?.cards.length ?? 0;
      return (
        <div class={["shell", "board", !connected.value && "lost"]}>
          <header class="bar">
            <a class="brand" href="#/">
              <span aria-hidden="true" class="brand-spectrum" />
              <span class="name">Agent Autoloop</span>
            </a>
            <div class="facts">
              <span>
                <span class={["dot", connected.value ? "on" : "off"]} />
                {connected.value ? "中台在线" : "中台断开"}
              </span>
              <a class="board-link" href="#/">
                返回总览
              </a>
            </div>
          </header>
          {!connected.value && <div class="banner">中台连不上了，正在重试。</div>}
          <main class="stage">
            {all && <Readouts snapshot={all} />}
            <section class="board-spectrum" aria-label="运行谱线">
              <div class="spectrum-head">
                <h2>运行谱线</h2>
                <div>
                  <span>实线 · 运行中</span>
                  <span>短线 · 历史</span>
                  <span class="legend-attention">双线 · 待回复</span>
                </div>
              </div>
              {all && !all.totals.running && !all.totals.queued && !all.totals.unknown && !waiting && (
                <div class="board-quiet">{marks.value.length ? "当前无待处理或运行中的事项" : "还没有运行记录"}</div>
              )}
              <div class="rail-wrap">
                <div class="rail">
                  {marks.value.map((mark) => (
                    <button
                      key={mark.key}
                      class="rail-line"
                      data-key={mark.key}
                      title={`${mark.title} · 点开看详情`}
                      aria-label={`${mark.rule} ${mark.label}`}
                      onClick={() => openMarkPlate(mark.key)}
                    >
                      <span class="stem-slot">
                        <span class={["stem", mark.form]} style={{ "--wl": mark.wl } as any} />
                        {mark.form === "waiting" && <span class="stem waiting" aria-hidden="true" />}
                      </span>
                      <span class="rail-tag">{mark.label}</span>
                    </button>
                  ))}
                </div>
                <div class="baseline" />
              </div>
            </section>
          </main>
          <footer class="legend">
            <div class="key">
              {[...new Map(marks.value.filter((mark) => mark.rule).map((mark) => [mark.rule, mark.wl])).entries()].map(
                ([name, wl]) => (
                  <span class="tick">
                    <span class="swatch" style={{ background: wl }} />
                    {name}
                  </span>
                ),
              )}
            </div>
            {all && (
              <>
                {all.unrouted.length > 0 && <span>{all.unrouted.length} 条事件没被接走</span>}
                <span class="gap">|</span>
                {[...new Set(all.agents.map((agent) => agent.worker))].map((worker) => (
                  <span class="tick">
                    <span
                      class={[
                        "dot",
                        all.agents.some((agent) => agent.worker === worker && agent.online) ? "on" : "off",
                      ]}
                    />
                    {all.agents.find((agent) => agent.worker === worker)?.name || worker}
                  </span>
                ))}
                {all.channels.map((channel) => (
                  <span class="tick" key={channel.id}>
                    <span class={["dot", channel.online ? "on" : "off"]} />
                    {channel.name}
                  </span>
                ))}
                <span class="gap">|</span>
                <span>
                  7 天 <b>{money(all.spending.week.cost)}</b>
                </span>
              </>
            )}
          </footer>
        </div>
      );
    };
  },
});
