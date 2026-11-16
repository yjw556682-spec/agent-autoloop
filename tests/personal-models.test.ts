// Model choices must stay bound to their task; management credentials must never reach inference or the browser.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { liteLLM } from "../examples/recipes/personal-multimachine/gateway.ts";
import { createPersonalServer } from "../examples/recipes/personal-multimachine/server.ts";
import { agentId, hash } from "../examples/recipes/personal-multimachine/data.ts";

const models = ["flash", "pro"].map((id) => ({
  id,
  label: id,
  provider: "Example",
  group: "日常",
  protocols: ["chat", "messages"] as ("chat" | "messages")[],
}));
test("API trials use restricted keys, revoke failed trials and expose only aggregate usage", async (t) => {
  const issued: any[] = [];
  const revoked: string[] = [];
  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    res.setHeader("content-type", "application/json");
    if (req.url === "/key/generate") {
      assert.equal(req.headers.authorization, "Bearer management-secret");
      issued.push(input);
      return res.end(JSON.stringify({ key: "temporary-key" }));
    }
    if (req.url === "/key/delete") {
      revoked.push(...input.keys);
      return res.end("{}");
    }
    if (req.url?.startsWith("/spend/logs"))
      return res.end(
        JSON.stringify([
          {
            model: "vendor/flash",
            model_group: "flash",
            spend: 0.003,
            total_tokens: 28,
            status: "success",
            api_key: "private",
            messages: "private",
          },
          { model: "flash", spend: 0, total_tokens: 0, status: "failure" },
        ]),
      );
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "flash" }, { id: "pro" }] }));
    assert.equal(req.headers.authorization, "Bearer temporary-key");
    if (req.url === "/v1/messages") {
      res.statusCode = 502;
      return res.end("secret upstream failure");
    }
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(input.model, "flash");
    return res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { total_tokens: 5 } }));
  }).listen(0, "127.0.0.1");
  await once(mock, "listening");
  t.after(() => {
    mock.closeAllConnections();
    mock.close();
  });
  const base = "http://127.0.0.1:" + (mock.address() as { port: number }).port;
  const gateway = liteLLM(
    { url: base, publicBase: base + "/v1", key: "management-secret", model: "flash", budget: 0.01, models },
    true,
  );
  const status = await gateway.status!();
  assert.equal(status.connected, true);
  assert.equal(status.usage?.requests, 2);
  assert.equal(status.usage?.usd, 0.003);
  assert.equal(status.usage?.models.find((m) => m.model === "flash")?.requests, 2);
  assert.ok(!JSON.stringify(status).includes("private"));
  const ok = await gateway.probe!("flash", "chat", "Reply OK");
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "OK");
  const failed = await gateway.probe!("flash", "messages", "Reply OK");
  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed).includes("secret"));
  assert.deepEqual(revoked, ["temporary-key", "temporary-key"]);
  assert.ok(issued.every((x) => x.models.length === 1 && x.models[0] === "flash" && x.max_budget === 0.01));
  await assert.rejects(() => gateway.probe!("unknown", "chat", "OK"));
  await assert.rejects(() => gateway.probe!("pro", "responses", "OK"));
  assert.equal(issued.length, 2);
});

test("default changes persist, new tasks can override them, and old tasks retain their model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autoloop-models-"));
  let taskId = "";
  let run = 0;
  const issued: string[] = [];
  const gateway = {
    models,
    defaultModel: "flash",
    async issue(_name: string, model = "flash") {
      issued.push(model);
      return { key: "lease", base: "http://127.0.0.1:1/v1", model };
    },
    async revoke() {},
  };
  const config = {
    database: join(root, "db.sqlite"),
    owner: "owner",
    gateway,
    devices: [
      {
        name: "desk",
        keyHash: hash("device"),
        agents: [
          { id: "writer", use: "claude" as const, mode: "api" as const, model: "flash", models: ["flash", "pro"] },
        ],
      },
    ],
    upstream: async (_method: string, path: string, _key: string, input?: unknown) => {
      if (path === "/v1/events") {
        taskId = (input as any).subject;
        return { status: 200, body: { routed: [agentId("desk", "writer")] } };
      }
      if (path.startsWith("/v1/work"))
        return {
          status: 200,
          body: {
            job: {
              run: ++run,
              attempt: 1,
              token: "run-token",
              agent: { id: agentId("desk", "writer"), use: "claude" },
              context: { events: [{ subject: taskId }] },
            },
            cancel: [],
          },
        };
      return { status: 200, body: {} };
    },
  };
  let server = createPersonalServer(config);
  const listen = async () => {
    server.http.listen(0, "127.0.0.1");
    await once(server.http, "listening");
    return "http://127.0.0.1:" + (server.http.address() as { port: number }).port;
  };
  let origin = await listen();
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = (path: string, body?: object, key = "owner") =>
    fetch(origin + path, {
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      ...(body && { method: "POST", body: JSON.stringify(body) }),
    });
  assert.equal(
    (await request("/personal/gateway/default", { node: "desk", agent: "writer", model: "pro" }, "device")).status,
    404,
  );
  assert.equal(
    (await request("/personal/tasks", { id: "old", text: "old task", node: "desk", agent: "writer" })).status,
    201,
  );
  const original = taskId;
  assert.equal(
    (await request("/personal/gateway/default", { node: "desk", agent: "writer", model: "pro" })).status,
    200,
  );
  const oldTask = await (await request("/personal/tasks/" + original)).json();
  assert.equal(oldTask.model, "flash");
  await request("/v1/work?claim=one", undefined, "device");
  assert.equal((await request("/personal/runs/1/1/lease", {}, "run-token")).status, 401);
  const leaseReply = await fetch(origin + "/personal/runs/1/1/lease", {
    method: "POST",
    headers: { authorization: "Bearer device", "x-run-token": "run-token", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(leaseReply.status, 200);
  assert.equal((await leaseReply.json()).model, "flash");
  await server.close();
  server = createPersonalServer(config);
  origin = await listen();
  assert.equal(
    (await request("/personal/tasks", { id: "new", text: "new task", node: "desk", agent: "writer" })).status,
    201,
  );
  assert.equal((await (await request("/personal/tasks/" + taskId)).json()).model, "pro");
  const override = { id: "override", text: "specific", node: "desk", agent: "writer", model: "flash" };
  assert.equal((await request("/personal/tasks", override)).status, 201);
  assert.equal((await (await request("/personal/tasks/" + taskId)).json()).model, "flash");
  assert.equal((await request("/personal/tasks", { ...override, model: "pro" })).status, 409);
  assert.equal((await request("/personal/tasks", { ...override, id: "invalid", model: "unconfigured" })).status, 409);
});
