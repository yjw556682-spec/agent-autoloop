/** One snapshot reader and one event stream per login. No business state or Vue dependency. */
export function createSession<T extends { seq: number }>(io: {
  fetchSnapshot(signal: AbortSignal): Promise<T>;
  stream(after: number, fact: (seq: number) => void, status: (up: boolean) => void): () => void;
  snapshot(value: T | null): void;
  error(message: string): void;
  status(up: boolean): void;
}) {
  let current: { refresh(): Promise<void>; stop(): void } | undefined;
  function stop() {
    current?.stop();
    current = undefined;
    io.snapshot(null);
    io.error("");
    io.status(false);
  }
  function start() {
    stop();
    const controller = new AbortController();
    let pending: Promise<void> | undefined;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopStream: (() => void) | undefined;
    let streamUp = false;
    let fresh = false;
    let retry = 500;
    const alive = () => !controller.signal.aborted;
    const schedule = (delay: number) => {
      if (!alive() || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, delay);
    };
    const refresh = (): Promise<void> => {
      if (!alive()) return Promise.resolve();
      if (pending) {
        dirty = true;
        return pending;
      }
      clearTimeout(timer);
      timer = undefined;
      dirty = false;
      pending = (async () => {
        try {
          const snapshot = await io.fetchSnapshot(controller.signal);
          if (!alive()) return;
          fresh = true;
          retry = 500;
          io.snapshot(snapshot);
          io.error("");
          if (!stopStream) {
            stopStream = io.stream(
              snapshot.seq,
              () => {
                if (alive()) schedule(350);
              },
              (up) => {
                if (!alive()) return;
                streamUp = up;
                io.status(streamUp && fresh);
                if (up) void refresh();
              },
            );
          }
          io.status(streamUp && fresh);
        } catch (error) {
          if (!alive()) return;
          fresh = false;
          io.status(false);
          io.error(error instanceof Error ? error.message : String(error));
        } finally {
          pending = undefined;
          if (alive() && !fresh) {
            schedule(retry);
            retry = Math.min(retry * 2, 15_000);
          } else if (alive() && dirty) schedule(350);
        }
      })();
      return pending;
    };
    current = {
      refresh,
      stop() {
        controller.abort();
        stopStream?.();
        clearTimeout(timer);
      },
    };
    return refresh();
  }
  return { start, stop, refresh: () => current?.refresh() ?? Promise.resolve() };
}
