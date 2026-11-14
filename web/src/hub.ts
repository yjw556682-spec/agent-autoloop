// Talking to the hub as its owner: one key, the doors from the 本人 section of the protocol, and the log as a stream.
import { ref } from "vue";
import { createTransport } from "./transport";
export { HubError } from "./transport";

const KEY_STORE = "agent-autoloop.owner-key";
declare global {
  interface Window {
    autoloopLocal?: { bootcamp: boolean; personal?: boolean };
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

export const key = ref(keyStore.getItem(KEY_STORE) ?? "");
export const connected = ref(false);

export function setKey(value: string) {
  key.value = value;
  if (value) keyStore.setItem(KEY_STORE, value);
  else keyStore.removeItem(KEY_STORE);
}

const { call, stream: openStream } = createTransport(
  () => key.value,
  () => setKey(""),
);
export { openStream };

export const fetchState = (before?: number, signal?: AbortSignal) =>
  call<State>(before === undefined ? "/v1/state" : `/v1/state?before=${before}`, { signal });
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

function post<T>(path: string, body: object, timeout?: number) {
  return call<T>(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    timeout,
  );
}

export const resolveCard = (id: number, reason: string) =>
  post<{ changed: boolean }>(`/v1/cards/${id}/resolve`, { reason });
export const controlRule = (name: string, action: "run" | "pause" | "resume" | "replay", body: object) =>
  post<{ changed?: boolean; run?: number; runs?: number[]; paused?: LineView["paused"] }>(
    `/v1/rules/${encodeURIComponent(name)}/${action}`,
    body,
  );
export const submitBootcamp = (link: string, plan: string) =>
  post<{ message: string }>("/local/bootcamp", { link, plan }, 95_000);

export type PersonalTask = {
  id: string;
  title?: string;
  node: string;
  agent: string;
  use?: string;
  mode: string;
  state: string;
  run: number | null;
};
export type PersonalDetails = PersonalTask & {
  files: { id: string; name: string; bytes: number; run: number; attempt: number }[];
  cleanup: { run: number; attempt: number; cleaned: number }[];
};
export const fetchPersonalTasks = (signal: AbortSignal) =>
  call<{
    tasks: PersonalTask[];
    devices: { name: string; online: boolean; agents: { id: string; use: string; mode: string }[] }[];
  }>("/local/personal/tasks", { signal });
export const fetchPersonalTask = (id: string, signal: AbortSignal) =>
  call<PersonalDetails>("/local/personal/tasks/" + encodeURIComponent(id), { signal });
export async function downloadPersonalFile(task: string, id: string, name: string) {
  const session = key.value;
  const response = await fetch(
    "/local/personal/tasks/" + encodeURIComponent(task) + "/files/" + encodeURIComponent(id),
    {
      headers: { authorization: "Bearer " + session },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error("成果暂时无法下载。");
  const content = await response.blob();
  if (session !== key.value) return;
  const url = URL.createObjectURL(content);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
