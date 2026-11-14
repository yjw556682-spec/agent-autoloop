// The local workbench must not forward cross-origin writes, expose the hub key, or change owner API semantics.
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup, beforeCleanup } from "./helpers.ts";

const home = setup("workbench");
const { serve } = await import("../host/http.ts");
const { addKey, db } = await import("../host/runtime.ts");
const { serveWorkbench } = await import("../scripts/workbench.ts");
beforeCleanup.push(() => {
  if (db.isOpen) db.close();
});
const owner = addKey("owner", "owner");
const worker = addKey("worker", "w1");
const source = addKey("source", "app");
const hub = serve(0, "127.0.0.1");
const token = "test-session-token";
const dashboard = serveWorkbench({ home, port: 0, token });
let base: string;

const origin = (server: typeof hub) => "http://127.0.0.1:" + (server.address() as AddressInfo).port;

before(async () => {
  await Promise.all([hub, dashboard].map((server) => server.listening || once(server, "listening")));
  base = origin(dashboard);
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: origin(hub), owner }));
  const session = await (await fetch(base + "/local-session.js")).text();
  assert.ok(!session.includes(owner));
  assert.ok(!session.includes(token));
});

after(() => {
  for (const server of [dashboard, hub]) {
    server.closeAllConnections();
    server.close();
  }
});

async function upstream(path: string, key: string, data?: object) {
  const response = await fetch(origin(hub) + path, {
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    ...(data && { method: "POST", body: JSON.stringify(data) }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function request(path: string, method = "GET", source = base, body?: unknown) {
  return fetch(base + path, {
    method,
    headers: {
      origin: source,
      authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("serves the bundled town artwork with its image type and policy", async () => {
  const page = await fetch(base + "/");
  assert.match(page.headers.get("content-security-policy") ?? "", /img-src 'self'/);
  const html = await page.text();
  const css = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
  assert.ok(css);
  const styles = await (await fetch(base + css)).text();
  const image = /(\/assets\/town-[\w-]+\.png)/.exec(styles)?.[1];
  assert.ok(image);
  const art = await fetch(base + image);
  assert.equal(art.status, 200);
  assert.equal(art.headers.get("content-type"), "image/png");
  assert.equal(
    Buffer.from(await art.arrayBuffer())
      .subarray(1, 4)
      .toString(),
    "PNG",
  );
});

test("keeps browser credentials local and limits the owner routes", async () => {
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/v1/state")).status, 401);
  assert.equal((await request("/local-session.js", "GET", "https://elsewhere.example")).status, 403);
  assert.equal((await request("/v1/state")).status, 200);
  assert.equal((await request("/v1/events", "POST", base, {})).status, 404);
  assert.equal((await request("/local/bootcamp", "POST", base, {})).status, 404);
  assert.equal(
    (await request("/v1/rules/" + encodeURIComponent("巡检") + "/run", "POST", "http://127.0.0.1:9", {})).status,
    403,
  );
});

test("starts a rule, streams the change, and cancels the resulting round", { timeout: 10_000 }, async () => {
  const before = await (await request("/v1/state")).json();
  const stream = await request("/v1/stream?after=" + before.seq);
  assert.equal(stream.status, 200);
  const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
  try {
    const rule = "/v1/rules/" + encodeURIComponent("巡检");
    assert.equal((await request(rule + "/pause", "POST", base, {})).status, 200);
    assert.equal((await request(rule + "/run", "POST", base, {})).status, 409);
    assert.equal((await request(rule + "/resume", "POST", base, {})).status, 200);
    const started = await request(rule + "/run", "POST", base, {});
    assert.equal(started.status, 200);
    const { run } = await started.json();
    let events = "";
    while (!events.includes('"seq":')) {
      const item = await reader.read();
      assert.equal(item.done, false);
      events += item.value;
    }
    assert.equal((await request("/v1/runs/" + run + "/why")).status, 200);
    assert.equal((await request("/v1/runs/" + run + "/cancel", "POST", base, {})).status, 200);
    const updated = await (await request("/v1/state")).json();
    assert.equal(updated.runs.find((row: { id: number }) => row.id === run).state, "cancelled");
  } finally {
    await reader.cancel();
  }
});

test("answers one card and closes the other without a channel key", async () => {
  await upstream("/v1/events", source, { id: "question", type: "feedback.new", subject: "#5" });
  const { job } = await upstream("/v1/work?claim=workbench-answer&wait=0", worker);
  await upstream("/v1/runs/" + job.run + "/result", job.token, {
    outcome: "done",
    ask: [{ title: "选一个", text: "选一种颜色", options: ["蓝色", "绿色"], key: "colour" }],
    notice: [{ title: "再看一眼", text: "需要复查" }],
  });
  const { cards } = await (await request("/v1/state")).json();
  const ask = cards.find((card: { kind: string }) => card.kind === "ask");
  const notice = cards.find((card: { kind: string }) => card.kind === "notice");
  assert.equal(
    (await (await request("/v1/cards/" + ask.id + "/answer", "POST", base, { choice: 0 })).json()).changed,
    true,
  );
  assert.equal(
    (await (await request("/v1/cards/" + ask.id + "/answer", "POST", base, { choice: 1 })).json()).changed,
    false,
  );
  assert.equal(
    (await (await request("/v1/cards/" + notice.id + "/resolve", "POST", base, { reason: "已核对" })).json()).changed,
    true,
  );
  const updated = await (await request("/v1/state")).json();
  assert.equal(updated.cards.length, 0);
  assert.equal(updated.recentCards.find((card: { id: number }) => card.id === ask.id).choice, 0);
});
