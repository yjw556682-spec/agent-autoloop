// Talking to the hub as its owner: one key, the doors from the 本人 section of the protocol, and the log as a stream.
import { ref } from "vue";

const KEY_STORE = "agent-autoloop.owner-key";
declare global {
  interface Window {
    autoloopLocal?: { bootcamp: boolean };
  }
}
export const local = window.autoloopLocal;
const initialSession =
  local && location.hash.startsWith("#/?session=") ? new URLSearchParams(location.hash.slice(3)).get("session") : null;
if (initialSession) {
  sessionStorage.setItem(KEY_STORE, initialSession);
  history.replaceState(null, "", location.pathname + "#/");
}
const keyStore = local ? sessionStorage : localStorage;

export type Spending = { rounds: number; tokens: number; cost: number; missingTokens: number; missingCost: number };
export type CardView = {
  id: number;
  version: number;
  kind: "ask" | "notice";
  state: "open" | "closed" | "decided" | "done";
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  by: string | null;
  result: string | null;
  rule: string;
  createdAt: string;
  decidedAt: string | null;
  closedAt: string | null;
};
export type RunView = {
  id: number;
  rule: string;
  agent: string;
  state: "queued" | "claimed" | "unknown" | "done" | "nothing" | "cancelled";
  attempts: number;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  notBefore: string;
  summary: string;
  error: string;
  link: string;
  session: string | null;
  usage: { input?: number; output?: number; cached?: number; cost?: number } | null;
  stopping: boolean;
  events: { source: string; type: string; subject: string; summary: string; link: string }[];
};
export type LineView = {
  id: string;
  name: string;
  agent: string;
  source: string | null;
  types: string[];
  every: string | null;
  next: string | null;
  paused?: { reason: string; since: string; until: string | null; skipped?: { count: number } | null } | null;
};
export type State = {
  now: string;
  timezone: string;
  seq: number;
  spending: { today: Spending; week: Spending };
  totals: {
    running: number;
    queued: number;
    retrying: number;
    unknown: number;
    done: number;
    doneToday: number;
    nothing: number;
    attention: number;
    usage: { input: number; output: number; cost: number };
  };
  cards: CardView[];
  recentCards: CardView[];
  lines: LineView[];
  agents: { id: string; name: string; worker: string; use?: string; seenAt: string | null; online: boolean }[];
  channels: { id: string; name: string; seenAt: string | null; online: boolean }[];
  runs: RunView[];
  hasMore: boolean;
  nextBefore: number | null;
  sources?: { id: string; name: string; events: number }[];
  timers?: { rule: string; key: string; at: string }[];
  elsewhere?: { name: string; next: string; where: string }[];
  unrouted: { id: number; source: string; type: string; subject: string; summary: string }[];
};

export type Fact = { seq: number; at: string; type: string; changes: { table: string; key: string; row: any }[] };

export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const key = ref(keyStore.getItem(KEY_STORE) ?? "");
export const connected = ref(true);

export function setKey(value: string) {
  key.value = value;
  if (value) keyStore.setItem(KEY_STORE, value);
  else keyStore.removeItem(KEY_STORE);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const answer = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...(key.value && { authorization: `Bearer ${key.value}` }) },
  });
  if (!answer.ok) {
    const text = await answer.text().catch(() => "");
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {}
    if (answer.status === 401 && key.value) setKey("");
    throw new HubError(answer.status, message || `中台没有答应（${answer.status}）`);
  }
  return answer.json() as Promise<T>;
}

export const fetchState = (before?: number) =>
  call<State>(before === undefined ? "/v1/state" : `/v1/state?before=${before}`);
export const fetchWhy = (run: number) => call<Fact[]>(`/v1/runs/${run}/why`);
export const emitEvent = (event: { id: string; type: string; subject?: string; summary?: string }) =>
  call<{ event: number; duplicate: boolean; routed: string[] }>("/v1/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
export const answerCard = (id: number, body: { choice?: number; text?: string }) =>
  call<{ changed: boolean }>(`/v1/cards/${id}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
export const cancelRun = (id: number) => call<{ ok: boolean }>(`/v1/runs/${id}/cancel`, { method: "POST" });

function post<T>(path: string, body: object) {
  return call<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const resolveCard = (id: number, reason: string) =>
  post<{ changed: boolean }>(`/v1/cards/${id}/resolve`, { reason });
export const controlRule = (name: string, action: "run" | "pause" | "resume" | "replay", body: object) =>
  post<{ changed?: boolean; run?: number; runs?: number[]; paused?: LineView["paused"] }>(
    `/v1/rules/${encodeURIComponent(name)}/${action}`,
    body,
  );
export const submitBootcamp = (link: string, plan: string) =>
  post<{ message: string }>("/local/bootcamp", { link, plan });

/**
 * The log as a stream, told over fetch so the owner key travels in a header (EventSource cannot send one). Reconnects
 * forever from the last sequence seen; onStatus(false) means the hub is not answering right now.
 */
export function openStream(after: number, onFact: (fact: Fact) => void, onStatus: (up: boolean) => void) {
  const controller = new AbortController();
  let cursor = after;
  let stopped = false;
  const run = async () => {
    let pause = 500;
    while (!stopped) {
      try {
        const answer = await fetch(`/v1/stream?after=${cursor}`, {
          headers: { authorization: `Bearer ${key.value}` },
          signal: controller.signal,
        });
        if (answer.status === 401) {
          if (key.value) setKey("");
          return;
        }
        if (!answer.ok || !answer.body) throw new Error(String(answer.status));
        onStatus(true);
        pause = 500;
        const reader = answer.body.pipeThrough(new TextDecoderStream()).getReader();
        let frame = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          frame += value;
          for (let end = frame.indexOf("\n\n"); end !== -1; end = frame.indexOf("\n\n")) {
            const message = frame.slice(0, end);
            frame = frame.slice(end + 2);
            const data = message
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => line.slice(6))
              .join("\n");
            if (!data) continue;
            const fact = JSON.parse(data) as Fact;
            cursor = Math.max(cursor, fact.seq);
            onFact(fact);
          }
        }
      } catch (error) {
        if (controller.signal.aborted || stopped) return;
      }
      onStatus(false);
      await new Promise((resolve) => setTimeout(resolve, pause));
      pause = Math.min(pause * 2, 15_000);
    }
  };
  void run();
  return () => {
    stopped = true;
    controller.abort();
  };
}
