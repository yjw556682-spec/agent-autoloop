// The real hub and supervised worker must deliver across separate homes, including a fresh review continuation.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { connectHub, personalRules } from "../examples/recipes/personal-multimachine/config.ts";
import { createPersonalServer } from "../examples/recipes/personal-multimachine/server.ts";
import { hash, type Profile } from "../examples/recipes/personal-multimachine/data.ts";

const root = await mkdtemp(join(tmpdir(), "autoloop-personal-integration-"));
process.env.AGENT_AUTOLOOP_HOME = root;
const rulesFile = join(root, "rules.json");
const nodes: { name: string; agents: Profile[] }[] = [
  {
    name: "alpha",
    agents: [
      { id: "writer", use: "codex", mode: "local" },
      { id: "analyst", use: "claude", mode: "api", model: "claude-fixture", keywords: ["数据分析"] },
    ],
  },
  { name: "beta", agents: [{ id: "reviewer", use: "zcode", mode: "api", model: "zcode-fixture" }] },
];
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
await writeFile(rulesFile, JSON.stringify(personalRules(nodes)));
const app = process.env.PERSONAL_TEST_HUB
  ? pathToFileURL(process.env.PERSONAL_TEST_HUB + "/").href
  : new URL("../", import.meta.url).href;
const { serve } = await import(new URL("host/http.ts", app).href);
const { addKey, db, execute } = await import(new URL("host/runtime.ts", app).href);
const hub = serve(0, "127.0.0.1");
await once(hub, "listening");
const owner = addKey("owner", "owner");
const sourceKey = addKey("source", "personal");
const keys = nodes.map((node) => addKey("worker", node.name));
const deviceRecords = nodes.map((node, index) => ({ ...node, keyHash: hash(keys[index]) }));
const issued: string[] = [];
const models: string[] = [];
const revoked: string[] = [];
const database = join(root, "personal.db");
const service = createPersonalServer({
  database,
  owner,
  devices: deviceRecords,
  upstream: connectHub({
    directory: root,
    owner,
    sourceKey,
    devices: deviceRecords,
    hub: "http://127.0.0.1:" + (hub.address() as AddressInfo).port,
  }),
  gateway: {
    async issue(_name, model) {
      const key = "fixture-lease-" + (issued.length + 1);
      issued.push(key);
      models.push(model!);
      return { key, model: model!, base: "http://127.0.0.1:1/v1" };
    },
    async revoke(key) {
      revoked.push(key);
    },
  },
});
service.http.listen(0, "127.0.0.1");
await once(service.http, "listening");
const url = "http://127.0.0.1:" + (service.http.address() as AddressInfo).port;
const workers: ChildProcess[] = [];
after(async () => {
  await Promise.all(
    workers.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const gone = once(child, "exit");
      child.kill();
      await gone;
    }),
  );
  service.http.closeAllConnections();
  await service.close();
  hub.closeAllConnections();
  await new Promise<void>((resolve) => hub.close(() => resolve()));
  await sleep(20);
  if (db.isOpen) db.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

async function request(path: string, input?: object) {
  const response = await fetch(url + path, {
    headers: { authorization: "Bearer " + owner, "content-type": "application/json" },
    ...(input && { method: "POST", body: JSON.stringify(input) }),
  });
  assert.ok(response.ok, `HTTP ${response.status}`);
  return response.json();
}

async function waitFor<T>(read: () => Promise<T | undefined>, description: string) {
  for (let tries = 0; tries < 200; tries++) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(100);
  }
  assert.fail(description);
}

test(
  "two worker processes deliver and clean up; private review continues without a local session",
  { timeout: 60_000 },
  async (t) => {
    const homes = nodes.map((node) => join(root, node.name));
    let output = "";
    for (const [index, node] of nodes.entries()) {
      const config = join(root, node.name + ".json");
      await writeFile(
        config,
        JSON.stringify({
          url,
          name: node.name,
          key: keys[index],
          capacity: 2,
          agents: node.agents.map((agent) => ({
            ...agent,
            program: process.execPath,
            isolatedHost: agent.use === "zcode",
            args: [join(import.meta.dirname, "fixtures", "personal-agents.mjs"), agent.id, agent.use],
          })),
          allowLoopback: true,
        }),
      );
      const child = spawn(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          join(import.meta.dirname, "../examples/recipes/personal-multimachine/main.ts"),
          "worker",
          config,
        ],
        {
          env: { ...process.env, AGENT_AUTOLOOP_HOME: homes[index], OPENAI_API_KEY: "should-not-be-inherited" },
          windowsHide: true,
        },
      );
      workers.push(child);
      child.stdout!.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr!.on("data", (chunk) => {
        output += String(chunk);
      });
    }
    t.after(async () => {
      await Promise.all(
        workers.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const gone = once(child, "exit");
          child.kill();
          await gone;
        }),
      );
      if (t.signal.aborted || !t.passed) t.diagnostic(output.slice(-5000));
    });
    await waitFor(
      async () =>
        (await request("/personal/tasks")).devices.every((d: { online: boolean }) => d.online) ? true : undefined,
      "workers did not connect",
    );
    const files = [{ name: "notes.md", data: Buffer.from("同一份资料").toString("base64") }];
    const [a, b, c] = await Promise.all([
      request("/personal/tasks", { id: "local", text: "writer local 审核", agent: "writer", files }),
      request("/personal/tasks", { id: "api", text: "reviewer api 总结", use: "zcode", files }),
      request("/personal/tasks", { id: "analyst", text: "analyst api 数据分析", files }),
    ]);
    const concurrent = await waitFor(async () => {
      const runs = await readdir(join(homes[0], "worker", "runs"));
      return runs.length >= 2 ? runs : undefined;
    }, "two agents did not run concurrently on alpha");
    assert.equal(new Set(concurrent).size, 2);
    const review = await waitFor(async () => {
      const state = await request("/personal/tasks/" + a.id);
      return state.state === "waiting-review" && state.cleanup[0]?.cleaned ? state : undefined;
    }, "local review was not stored and cleaned");
    const cards = db.prepare("SELECT id FROM cards WHERE state = 'open'").all();
    assert.equal(cards.length, 1);
    execute("answer", [Number(cards[0].id), { choice: 0 }], Date.now());
    const completed = await Promise.all(
      [a, b, c].map((item) =>
        waitFor(async () => {
          const state = await request("/personal/tasks/" + item.id);
          return state.state === "done" && state.cleanup.every((entry: { cleaned: number }) => entry.cleaned)
            ? state
            : undefined;
        }, "task did not finish and clean"),
      ),
    );
    assert.deepEqual(
      completed.map((state) => [state.node, state.agent, state.use]),
      [
        ["alpha", "writer", "codex"],
        ["beta", "reviewer", "zcode"],
        ["alpha", "analyst", "claude"],
      ],
    );
    assert.equal(review.files[0].name, "checkpoint.md");
    assert.equal(completed[0].files.length, 2);
    assert.equal(completed[1].files[0].name, "response.md");
    const answer = await fetch(url + "/personal/tasks/" + b.id + "/files/" + completed[1].files[0].id, {
      headers: { authorization: "Bearer " + owner },
    });
    assert.equal(await answer.text(), "同一份资料 · reviewer api 总结\n");
    assert.equal(issued.length, 2);
    assert.deepEqual(models.toSorted(), ["claude-fixture", "zcode-fixture"]);
    assert.deepEqual(revoked.toSorted(), issued.toSorted());
    for (const home of homes) {
      assert.deepEqual(await readdir(join(home, "worker", "runs")), []);
      await assert.rejects(readFile(join(home, "worker", "usage.json")));
    }
  },
);
