// The one session the app runs: state in hand, the log streaming beside it, and a refresh whenever a fact lands.
import { ref } from "vue";
import { connected, fetchState, key, openStream, type State } from "./hub";

export { connected };

export const state = ref<State | null>(null);
export const loadError = ref("");

let stopStream: (() => void) | null = null;
let pending = false;
let session = 0;
let request = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Facts arrive faster than they matter: one refetch covers a burst. */
function scheduleRefresh() {
  if (pending) return;
  pending = true;
  timer = setTimeout(async () => {
    pending = false;
    await refresh();
  }, 350);
}

export async function refresh() {
  if (!key.value) return;
  const currentSession = session;
  const ticket = ++request;
  try {
    const snapshot = await fetchState();
    if (currentSession !== session || ticket !== request) return;
    state.value = snapshot;
    connected.value = true;
    loadError.value = "";
  } catch (error) {
    if (currentSession !== session || ticket !== request) return;
    connected.value = false;
    loadError.value = error instanceof Error ? error.message : String(error);
    if (!connected.value) scheduleRefresh();
  }
}

export async function startSession() {
  stopSession();
  // Read the log from where the state snapshot stands, not from zero: a hub with history would replay all of it.
  const currentSession = session;
  await refresh();
  if (currentSession !== session || !key.value) return;
  let cursor = state.value?.seq ?? 0;
  const wire = () => {
    stopStream = openStream(
      cursor,
      (fact) => {
        cursor = Math.max(cursor, fact.seq);
        scheduleRefresh();
      },
      (up) => {
        connected.value = up;
        if (up) void refresh();
      },
    );
  };
  wire();
}

export function stopSession() {
  session++;
  stopStream?.();
  stopStream = null;
  if (timer) clearTimeout(timer);
  timer = null;
  pending = false;
  state.value = null;
  loadError.value = "";
  connected.value = true;
}
