// What stands on the rail, shared by the overview and the board: one line per run in its state's form, one sodium line
// per open card. Done rounds stay as fading stubs, only a few of them, so the recent past never crowds the live present.
import type { State } from "./hub";
import { wavelength } from "./wave";

export type MarkForm = "live" | "queued" | "dashed" | "stub" | "struck" | "waiting" | "notice";
export type Mark = {
  key: string;
  id: number;
  form: MarkForm;
  wl: string;
  at: number;
  label: string;
  title: string;
  rule: string;
};

const STUBS_KEPT = 18;

const formOf = (run: State["runs"][number]): MarkForm =>
  run.stopping
    ? "struck"
    : run.state === "claimed"
      ? "live"
      : run.state === "unknown"
        ? "dashed"
        : run.state === "queued"
          ? run.attempts > 0
            ? "dashed"
            : "queued"
          : run.state === "cancelled"
            ? "struck"
            : "stub";

export function marksOf(all: State): Mark[] {
  const list: Mark[] = [
    ...all.runs.map((run) => ({
      key: `run:${run.id}`,
      id: run.id,
      form: formOf(run),
      wl: wavelength(run.rule),
      at: Date.parse(run.createdAt),
      label: `#${run.id}`,
      title: run.rule,
      rule: run.rule,
    })),
    ...all.cards.map((card) => ({
      key: `card:${card.id}`,
      id: card.id,
      form: card.kind === "ask" ? ("waiting" as const) : ("notice" as const),
      wl: wavelength(card.rule),
      at: Date.parse(card.createdAt),
      label: `卡#${card.id}`,
      title: card.title,
      rule: card.rule,
    })),
  ];
  return list
    .filter((mark) => mark.form !== "stub")
    .concat(list.filter((mark) => mark.form === "stub").slice(0, STUBS_KEPT))
    .sort((a, b) => a.at - b.at || a.id - b.id);
}
