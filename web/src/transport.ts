export class HubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** HTTP and SSE use a fixed credential per request. Writes are never automatically retried. */
export function createTransport(getKey: () => string, invalidate: () => void, fetcher: typeof fetch = fetch) {
  const expired = (credential: string) => {
    if (credential && getKey() === credential) invalidate();
  };
  async function call<T>(path: string, init?: RequestInit, timeout = 15_000): Promise<T> {
    const credential = getKey();
    const deadline = AbortSignal.timeout(timeout);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const headers = new Headers(init?.headers);
    if (credential) headers.set("authorization", "Bearer " + credential);
    try {
      const answer = await fetcher(path, { ...init, signal, headers });
      if (!answer.ok) {
        const text = await answer.text().catch(() => "");
        let message = text;
        try {
          message = JSON.parse(text).error ?? text;
        } catch {}
        if (answer.status === 401) expired(credential);
        throw new HubError(answer.status, message || `中台没有答应（${answer.status}）`);
      }
      return (await answer.json()) as T;
    } catch (error) {
      if (deadline.aborted && !init?.signal?.aborted) {
        throw new HubError(
          408,
          init?.method === "POST" ? "等待结果超时，请先查看运行记录再重试。" : "读取状态超时，正在等待中台恢复。",
        );
      }
      throw error;
    }
  }
  function stream(after: number, onFact: (fact: { seq: number }) => void, onStatus: (up: boolean) => void) {
    const controller = new AbortController();
    const credential = getKey();
    const alive = () => !controller.signal.aborted && getKey() === credential;
    let cursor = after;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const run = async () => {
      let pause = 500;
      while (alive()) {
        try {
          const answer = await fetcher(`/v1/stream?after=${cursor}`, {
            headers: { authorization: `Bearer ${credential}` },
            signal: controller.signal,
          });
          if (!alive()) {
            await answer.body?.cancel();
            return;
          }
          if (answer.status === 401) {
            await answer.body?.cancel();
            expired(credential);
            return;
          }
          if (!answer.ok || !answer.body) {
            await answer.body?.cancel();
            throw new Error(String(answer.status));
          }
          onStatus(true);
          const reader = answer.body.pipeThrough(new TextDecoderStream()).getReader();
          let frame = "";
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (!alive() || done) break;
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
                const fact = JSON.parse(data) as { seq: number };
                if (!Number.isSafeInteger(fact.seq) || fact.seq <= cursor) continue;
                cursor = fact.seq;
                pause = 500;
                onFact(fact);
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        } catch {
          if (!alive()) return;
        }
        if (!alive()) return;
        onStatus(false);
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, pause);
        });
        wake = undefined;
        pause = Math.min(pause * 2, 15_000);
      }
    };
    void run();
    return () => {
      controller.abort();
      clearTimeout(timer);
      wake?.();
    };
  }
  return { call, stream };
}
