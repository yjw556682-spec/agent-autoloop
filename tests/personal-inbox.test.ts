// Feishu intake must not execute before owner selection, and concurrent confirmation must never dispatch twice.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createPersonalServer, type Upstream } from "../examples/recipes/personal-multimachine/server.ts";
import { agentId, hash } from "../examples/recipes/personal-multimachine/data.ts";

test("Feishu waits across restart for one owner-selected Agent and model, retaining private delivery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-inbox-"));
  const events: unknown[] = [];
  let failDispatch = true;
  const config: Parameters<typeof createPersonalServer>[0] = {
    database: join(dir, "personal.sqlite"),
    owner: "owner",
    devices: [
      {
        name: "desk",
        keyHash: hash("device"),
        agents: [
          { id: "writer", use: "claude", mode: "api" as const, model: "flash", models: ["flash", "mini"] },
          { id: "coder", use: "codex", mode: "api" as const, model: "flash", models: ["flash", "mini"] },
        ],
      },
    ],
    gateway: {
      models: ["flash", "mini"].map((id) => ({
        id,
        label: id,
        provider: "test",
        group: "test",
        protocols: ["messages", "responses"] as ("messages" | "responses")[],
      })),
      issue: async () => {
        assert.fail("no key before worker claim");
      },
      revoke: async () => {},
    },
    upstream: (async (_method, path, _key, body) => {
      assert.equal(path, "/v1/events");
      if (failDispatch) return { status: 503, body: {} };
      events.push(body);
      return { status: 200, body: { routed: [agentId("desk", "coder")] } };
    }) satisfies Upstream,
  };
  let server = createPersonalServer(config);
  const listen = async () => {
    server.http.listen(0, "127.0.0.1");
    await once(server.http, "listening");
    return `http://127.0.0.1:${(server.http.address() as { port: number }).port}`;
  };
  let origin = await listen();
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (path: string, body?: object, key = "owner") =>
    fetch(origin + path, {
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      ...(body && { method: "POST", body: JSON.stringify(body) }),
    });
  const request = {
    id: "feishu:om_one",
    text: "请总结方案",
    files: [{ name: "方案.md", data: Buffer.from("版本一").toString("base64") }],
  };
  const first = await server.receiveFromFeishu(request, "private-target");
  const id = (first.body as { id: string }).id;
  assert.equal((first.body as { state: string }).state, "awaiting-config");
  await server.receiveFromFeishu(request, "private-target");
  assert.equal((await (await call("/personal/inbox")).json()).length, 1);
  assert.equal((await (await call("/personal/tasks")).json()).tasks.length, 0);
  assert.equal(events.length, 0);
  assert.equal((await call("/personal/inbox", undefined, "device")).status, 404);
  assert.equal(
    (await call(`/personal/inbox/${id}/dispatch`, { node: "desk", agent: "coder", model: "mini" }, "device")).status,
    404,
  );
  await server.close();
  server = createPersonalServer(config);
  origin = await listen();
  assert.equal(server.known(request.id)?.state, "awaiting-config");
  const pending = await (await call("/personal/inbox")).json();
  assert.equal(pending[0].text, request.text);
  assert.equal(pending[0].files[0].name, "方案.md");
  assert.equal(JSON.stringify(pending).includes("private-target"), false);
  assert.equal(
    (await call(`/personal/inbox/${id}/dispatch`, { node: "desk", agent: "coder", model: "unknown" })).status,
    409,
  );
  const choice = { node: "desk", agent: "coder", model: "mini" };
  assert.equal((await call(`/personal/inbox/${id}/dispatch`, choice)).status, 503);
  assert.equal((await call(`/personal/inbox/${id}/dispatch`, { ...choice, agent: "writer" })).status, 409);
  failDispatch = false;
  const replies = await Promise.all([
    call(`/personal/inbox/${id}/dispatch`, choice),
    call(`/personal/inbox/${id}/dispatch`, choice),
  ]);
  assert.ok(replies.every((r) => r.ok));
  assert.equal(events.length, 1);
  const task = await (await call("/personal/tasks/" + id)).json();
  assert.equal(task.agent, "coder");
  assert.equal(task.model, "mini");
  const snapshot = new DatabaseSync(config.database, { readOnly: true });
  assert.equal(snapshot.prepare("SELECT target FROM feishu_deliveries WHERE task=?").get(id)?.target, "private-target");
  const input = JSON.parse(String(snapshot.prepare("SELECT input FROM tasks WHERE id=?").get(id)?.input));
  assert.deepEqual(input.files, request.files);
  snapshot.close();
  assert.equal((await (await call("/personal/inbox")).json()).length, 0);
  assert.equal((await call(`/personal/inbox/${id}/discard`, {})).status, 409);
  const second = await server.receiveFromFeishu({ ...request, id: "feishu:om_two" }, "private-target");
  const secondId = (second.body as { id: string }).id;
  assert.equal((await call(`/personal/inbox/${secondId}/discard`, {})).status, 200);
  assert.equal((await call(`/personal/inbox/${secondId}/dispatch`, choice)).status, 409);
  assert.equal(server.known("feishu:om_two")?.state, "discarded");
});
