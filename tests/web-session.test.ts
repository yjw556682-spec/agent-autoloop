import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession } from "../web/src/session-controller.ts";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("one snapshot at a time; a burst during a read schedules one catch-up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reads: ReturnType<typeof deferred<{ seq: number }>>[] = [];
  const snapshots: number[] = [];
  let fact!: (seq: number) => void;
  let online!: (up: boolean) => void;
  let connected = false;
  const session = createSession({
    fetchSnapshot: async () => {
      const read = deferred<{ seq: number }>();
      reads.push(read);
      return read.promise;
    },
    stream: (_after, onFact, onStatus) => {
      fact = onFact;
      online = onStatus;
      return () => {};
    },
    snapshot: (value) => {
      if (value) snapshots.push(value.seq);
    },
    error: () => {},
    status: (up) => {
      connected = up;
    },
  });
  t.after(() => session.stop());
  const start = session.start();
  reads[0].resolve({ seq: 10 });
  await start;
  online(true);
  await flush();
  for (let i = 11; i < 25; i++) fact(i);
  t.mock.timers.tick(350);
  await flush();
  assert.equal(reads.length, 2);
  reads[1].resolve({ seq: 20 });
  await flush();
  t.mock.timers.tick(350);
  await flush();
  assert.equal(reads.length, 3);
  online(false);
  reads[2].resolve({ seq: 25 });
  await flush();
  assert.deepEqual(snapshots, [10, 20, 25]);
  assert.equal(connected, false, "a successful HTTP read must not conceal a broken event stream");
});

test("failed initial snapshots back off and never replay history from zero", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let streamCalls = 0;
  const session = createSession({
    fetchSnapshot: async () => {
      calls++;
      throw new Error("offline");
    },
    stream: () => {
      streamCalls++;
      return () => {};
    },
    snapshot: () => {},
    error: () => {},
    status: () => {},
  });
  t.after(() => session.stop());
  await session.start();
  t.mock.timers.tick(499);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  t.mock.timers.tick(999);
  await flush();
  assert.equal(calls, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 3);
  assert.equal(streamCalls, 0);
  session.stop();
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(calls, 3);
});

test("switching sessions aborts reads and ignores late responses and callbacks", async () => {
  const first = deferred<{ seq: number }>();
  let signal!: AbortSignal;
  const seen: (number | null)[] = [];
  let calls = 0;
  let streams = 0;
  const session = createSession({
    fetchSnapshot: async (abort) => {
      signal = abort;
      return ++calls === 1 ? first.promise : { seq: 99 };
    },
    stream: () => {
      streams++;
      return () => {};
    },
    snapshot: (value) => {
      seen.push(value?.seq ?? null);
    },
    error: () => {},
    status: () => {},
  });
  const previous = session.start();
  const oldSignal = signal;
  await session.start();
  assert.equal(oldSignal.aborted, true);
  first.resolve({ seq: 1 });
  await previous;
  assert.equal(seen.at(-1), 99);
  assert.equal(streams, 1);
  session.stop();
});
