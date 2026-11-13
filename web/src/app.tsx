// The app is two views of one session: the overview you work at, and the board you hang on a wall. The key decides
// whether any of it shows.
import { defineComponent, onUnmounted, ref, watch } from "vue";
import { key } from "./hub";
import { Board } from "./board";
import { Login } from "./login";
import { Overview } from "./overview";
import { startSession, stopSession } from "./session";

export const App = defineComponent({
  setup() {
    const route = ref(location.hash);
    const onHash = () => (route.value = location.hash);
    window.addEventListener("hashchange", onHash);
    onUnmounted(() => {
      window.removeEventListener("hashchange", onHash);
      stopSession();
    });
    watch(
      key,
      (value) => {
        if (value) startSession();
        else stopSession();
      },
      { immediate: true },
    );
    return () => {
      if (!key.value) return <Login />;
      return route.value.startsWith("#/board") ? <Board /> : <Overview />;
    };
  },
});
