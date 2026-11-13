import assert from "node:assert/strict";
import { test } from "node:test";
import { createTransport } from "../web/src/transport.ts";
import { createSubmission } from "../web/src/submission.ts";

test("an expired old request cannot log out a newer session", async () => {
  let key = "old";
  let done!: (value: Response) => void;
  const transport = createTransport(
    () => key,
    () => {
      key = "";
    },
    async () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const old = transport.call("/state");
  key = "new";
  done(new Response('{"error":"expired"}', { status: 401 }));
  await assert.rejects(old, /expired/);
  assert.equal(key, "new");
});

test("current authentication failure clears the current credential", async () => {
  let key = "current";
  const transport = createTransport(
    () => key,
    () => {
      key = "";
    },
    async () => new Response("denied", { status: 401 }),
  );
  await assert.rejects(transport.call("/state"), /denied/);
  assert.equal(key, "");
});

test("stopping a stream prevents late callbacks and reconnection", async () => {
  let done!: (value: Response) => void;
  let notifications = 0;
  const transport = createTransport(
    () => "key",
    () => {},
    async () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const stop = transport.stream(
    2,
    () => {
      notifications++;
    },
    () => {
      notifications++;
    },
  );
  stop();
  done(new Response('data: {"seq":3}\n\n', { headers: { "content-type": "text/event-stream" } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications, 0);
});

test("an uncertain submission keeps its event ID until acknowledged; editing creates a new one", async () => {
  let sequence = 0;
  const submission = createSubmission(() => String(++sequence));
  const draft = { type: "manual.task", subject: "#1" };
  const first = submission.prepare(draft);
  assert.equal(submission.prepare(draft).id, first.id);
  assert.notEqual(submission.prepare({ ...draft, subject: "#2" }).id, first.id);
  const second = submission.prepare(draft);
  submission.accepted();
  assert.notEqual(submission.prepare(draft).id, second.id);
});

test("a timed-out write is reported as uncertain and is not retried", async () => {
  let calls = 0;
  const transport = createTransport(
    () => "key",
    () => {},
    async (_path, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    },
  );
  // Keep Node alive while AbortSignal.timeout's unref'ed deadline elapses.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(transport.call("/submit", { method: "POST" }, 5), /先查看运行记录/);
    assert.equal(calls, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});
