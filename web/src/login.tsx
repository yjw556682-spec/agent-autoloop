// The gate: one key, checked against the hub before anything else loads. The doublet above the box is the line that will
// stand for the thing waiting on you, shown here at rest.
import { ref } from "vue";
import { defineComponent } from "vue";
import { fetchState, local, setKey } from "./hub";

export const Login = defineComponent({
  setup() {
    const typed = ref("");
    const wrong = ref(false);
    const busy = ref(false);
    // The key watcher in app.tsx starts the session; entering only checks that the key opens the door.
    const enter = async () => {
      busy.value = true;
      wrong.value = false;
      setKey(typed.value.trim());
      try {
        await fetchState();
      } catch {
        wrong.value = true;
        setKey("");
      }
      busy.value = false;
    };
    return () => (
      <div class="gate">
        <div class="name" style={{ fontSize: "12px", letterSpacing: "0.16em", color: "var(--ink-mid)" }}>
          AGENT AUTOLOOP
        </div>
        <div class={["doublet", wrong.value && "dashed"]}>
          <i />
          <i />
        </div>
        <input
          class="word"
          type="password"
          autocomplete="off"
          placeholder={local ? "本机会话密钥" : "本人的密钥"}
          aria-label="本人的密钥"
          value={typed.value}
          onInput={(event) => (typed.value = (event.target as HTMLInputElement).value)}
          onKeydown={(event) => event.key === "Enter" && !busy.value && enter()}
        />
        <button class="act best" disabled={busy.value || !typed.value.trim()} onClick={enter}>
          {busy.value ? "正在对钥匙…" : "进门"}
        </button>
        <div class="err">{wrong.value ? "钥匙不对，或中台没连上。" : ""}</div>
        <div class="hint">
          {local ? (
            "请从「打开工作台」重新打开会话，或使用启动时显示的完整链接。"
          ) : (
            <>
              在装中台的电脑上运行 <b>agent-autoloop key new owner web</b>{" "}
              拿一把自己的密钥，只显示一次。中台默认只听本机；要手机打开，把 hub.publicUrl 配成能访问的地址。
            </>
          )}
        </div>
      </div>
    );
  },
});
