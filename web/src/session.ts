// Vue bindings for one session shared by every view. The controller owns its lifetime.
import { ref } from "vue";
import { connected, fetchState, openStream, type State } from "./hub";
import { createSession } from "./session-controller";

export { connected };
export const state = ref<State | null>(null);
export const loadError = ref("");

const session = createSession<State>({
  fetchSnapshot: (signal) => fetchState(undefined, signal),
  stream: (after, onFact, onStatus) => openStream(after, (fact) => onFact(fact.seq), onStatus),
  snapshot: (snapshot) => {
    state.value = snapshot;
  },
  error: (message) => {
    loadError.value = message;
  },
  status: (up) => {
    connected.value = up;
  },
});
export const refresh = session.refresh;
export const startSession = session.start;
export const stopSession = session.stop;
