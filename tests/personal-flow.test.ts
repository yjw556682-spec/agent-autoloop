// A task must only reach its assigned device, survive an uncertain receipt, and remain downloadable after local cleanup.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { createPersonalServer } from "../examples/recipes/personal-multimachine/server.ts";
import { prepareRun, finishRun, type Device } from "../examples/recipes/personal-multimachine/device.ts";
import { agentId, hash } from "../examples/recipes/personal-multimachine/data.ts";

test("an assigned worker uploads once, retries a lost receipt, then cleans its files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autoloop-personal-"));
  const owner = "owner-fixture";
  let taskId = "";
  let submissions = 0;
  let replies = 0;
  const job = () => ({
    run: 1,
    attempt: 1,
    token: "run-token",
    session: null,
    agent: { id: agentId("a", "writer"), use: "codex" },
    context: { events: [{ subject: taskId }] },
  });
  const server = createPersonalServer({
    database: join(root, "server.db"),
    owner,
    devices: [
      { name: "a", keyHash: hash("key-a"), agents: [{ id: "writer", use: "codex", mode: "local" }] },
      { name: "b", keyHash: hash("key-b"), agents: [{ id: "writer", use: "claude", mode: "api" }] },
    ],
    upstream: async (method, path, key, body) => {
      if (path === "/v1/events") {
        submissions++;
        taskId = (body as { subject: string }).subject;
        return { status: 200, body: { event: 1, routed: [agentId("a", "writer")] } };
      }
      if (path.startsWith("/v1/work"))
        return { status: 200, body: { job: key === "key-a" ? job() : null, cancel: [] } };
      assert.equal(method, "POST");
      assert.equal(key, "run-token");
      replies++;
      return { status: replies === 1 ? 503 : 200, body: replies === 1 ? {} : { rejected: [] } };
    },
  });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  server.http.listen(0, "127.0.0.1");
  await once(server.http, "listening");
  const origin = "http://127.0.0.1:" + (server.http.address() as { port: number }).port;
  const request = (path: string, key: string, body?: unknown) =>
    fetch(origin + path, {
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  await request("/v1/work?claim=ready-a", "key-a");
  await request("/v1/work?claim=ready-b", "key-b");
  const knowledge = await request("/personal/knowledge", owner, {
    files: [{ name: "notes.md", data: Buffer.from("课程资料").toString("base64") }],
  });
  assert.equal(knowledge.status, 201);
  const [{ id: version }] = await knowledge.json();
  assert.equal((await request("/personal/knowledge", "key-a")).status, 404);
  const submission = { id: "one", text: "用给定资料总结课程", mode: "local", knowledge: [version] };
  const accepted = await request("/personal/tasks", owner, submission);
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).id, taskId);
  assert.equal((await request("/personal/tasks", owner, submission)).status, 200);
  assert.equal(submissions, 1);
  const claim = await request("/v1/work?claim=take-a", "key-a");
  assert.equal((await claim.json()).job.run, 1);
  assert.equal(
    (
      await fetch(origin + "/personal/runs/1/1/input", {
        headers: { authorization: "Bearer key-b", "x-run-token": "run-token" },
      })
    ).status,
    403,
  );
  const device: Device = {
    url: origin,
    name: "a",
    key: "key-a",
    agents: [{ id: "writer", use: "codex", mode: "local", program: "codex" }],
    allowLoopback: true,
  };
  const dir = join(root, "worker", "1-1");
  await assert.rejects(prepareRun(device, { ...job(), agent: { ...job().agent, use: "claude" } }, dir), /本机执行方式/);
  const launched = await prepareRun(device, job(), dir);
  assert.equal(await readFile(join(launched.cwd, "input", "notes.md"), "utf8"), "课程资料");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(launched.cwd, "output", "draft.md"), "可交付草稿");
  const result = { outcome: "done" as const, summary: "已生成草稿" };
  await assert.rejects(finishRun(device, job(), dir, result), /503/);
  assert.ok((await readdir(dir)).includes("workspace"));
  await finishRun(device, job(), dir, result);
  await rm(dir, { recursive: true });
  await assert.rejects(readFile(join(launched.cwd, "output", "draft.md")));
  const status = await (await request("/personal/tasks/" + taskId, owner)).json();
  assert.equal(status.state, "done");
  assert.equal(status.files.length, 1);
  const saved = await request("/personal/tasks/" + taskId + "/files/" + status.files[0].id, owner);
  assert.equal(await saved.text(), "可交付草稿");
  assert.equal(replies, 2);
});
