import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
import {
  agentId,
  agentNames,
  equal,
  files,
  hash,
  label,
  maxBytes,
  number,
  Problem,
  supportsAgent,
  taskName,
  type Mode,
  type Profile,
  type Run,
} from "./data.ts";
import { parseResult } from "../../../protocol/validate.ts";

export type DeviceRecord = { name: string; keyHash: string; agents: Profile[] };
type Reply = { status: number; body: unknown };
export type Upstream = (method: string, path: string, key: string, body?: unknown) => Promise<Reply>;
export type Lease = { key: string; base: string; model: string };
export type Gateway = {
  issue: (name: string, model?: string) => Promise<Lease>;
  revoke: (key: string) => Promise<void>;
};
type Options = { database: string; owner: string; devices: DeviceRecord[]; upstream: Upstream; gateway?: Gateway };
type Task = {
  id: string;
  fingerprint: string;
  node: string;
  agent: string;
  mode: Mode;
  input: string;
  state: string;
  run: number | null;
  created: number;
};
type Claim = {
  run: number;
  attempt: number;
  task: string;
  node: string;
  token: string;
  receipt: string | null;
  ack: string | null;
  closed: number;
  lease: string | null;
  stopping: number;
};
const json = (body: unknown, status = 200): Reply => ({ body, status });
const onlineFor = 90_000;
const bearer = (req: IncomingMessage) => /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
const submissionId = (id: string) => "personal-" + hash(id).slice(0, 24);

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBytes * 1.4 + 128_000) throw new Problem(413, "请求太大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Problem(400, "请求必须是 JSON");
  }
}

export function createPersonalServer({ database, owner, devices, upstream, gateway }: Options) {
  if (
    !owner ||
    !devices.length ||
    new Set(devices.map((d) => d.name)).size !== devices.length ||
    new Set(devices.map((d) => d.keyHash)).size !== devices.length ||
    devices.some(
      (d) =>
        !label.test(d.name) ||
        !/^[0-9a-f]{64}$/.test(d.keyHash) ||
        !d.agents.length ||
        new Set(d.agents.map((agent) => agent.id)).size !== d.agents.length ||
        d.agents.some(
          (agent) =>
            !label.test(agent.id) ||
            agent.id.includes("--") ||
            !supportsAgent(agent) ||
            (agent.keywords &&
              (!Array.isArray(agent.keywords) ||
                agent.keywords.some((word) => typeof word !== "string" || !word.trim()))),
        ) ||
        d.name.includes("--") ||
        equal(d.keyHash, hash(owner)),
    )
  )
    throw new Error("请配置不同的设备身份与本人身份");
  const db = new DatabaseSync(database);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, node TEXT NOT NULL, agent TEXT NOT NULL, mode TEXT NOT NULL,
      input TEXT NOT NULL, state TEXT NOT NULL, run INTEGER, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claims (
      run INTEGER NOT NULL, attempt INTEGER NOT NULL, task TEXT NOT NULL REFERENCES tasks(id),
      node TEXT NOT NULL, token TEXT NOT NULL, receipt TEXT, ack TEXT, closed INTEGER NOT NULL DEFAULT 0,
      cleaned INTEGER NOT NULL DEFAULT 0, stopping INTEGER NOT NULL DEFAULT 0, lease TEXT,
      PRIMARY KEY(run, attempt)
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), run INTEGER NOT NULL,
      attempt INTEGER NOT NULL, name TEXT NOT NULL, content BLOB NOT NULL, digest TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, content BLOB NOT NULL, created INTEGER NOT NULL
    );
  `);
  const getTask = (id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
  const getClaim = (run: number, attempt: number) =>
    db.prepare("SELECT * FROM claims WHERE run = ? AND attempt = ?").get(run, attempt) as Claim | undefined;
  const seen = new Map<string, { at: number; free: boolean }>();
  const pending = new Map<string, Promise<Reply>>();

  async function once(key: string, work: () => Promise<Reply>) {
    const inFlight = pending.get(key);
    if (inFlight) {
      await inFlight.catch(() => {});
      return once(key, work);
    }
    const operation = work();
    pending.set(key, operation);
    try {
      return await operation;
    } finally {
      pending.delete(key);
    }
  }

  function listFiles(task: string) {
    return db
      .prepare(
        `
      SELECT files.id, name, digest, length(content) AS bytes, files.run, files.attempt
      FROM files JOIN claims USING (run, attempt)
      WHERE files.task = ? AND claims.ack IS NOT NULL ORDER BY files.run, files.attempt, name
    `,
      )
      .all(task);
  }

  async function submit(value: any) {
    if (
      typeof value?.id !== "string" ||
      !value.id.trim() ||
      value.id.length > 200 ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      value.text.length > 100_000 ||
      (value.mode !== undefined && value.mode !== "local" && value.mode !== "api") ||
      (value.use !== undefined && (typeof value.use !== "string" || !Object.hasOwn(agentNames, value.use))) ||
      (value.agent !== undefined && (typeof value.agent !== "string" || !label.test(value.agent))) ||
      (value.node !== undefined && (typeof value.node !== "string" || !label.test(value.node)))
    )
      throw new Problem(400, "需要提交编号、任务说明和有效的执行方式");
    const inputFiles = files(value.files ?? []);
    const references: unknown = value.knowledge ?? [];
    if (
      !Array.isArray(references) ||
      references.length > 32 ||
      references.some((id) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id))
    )
      throw new Problem(400, "资料引用无效");
    const fingerprint = hash(
      JSON.stringify([
        value.text,
        inputFiles,
        references,
        value.mode ?? null,
        value.node ?? null,
        value.agent ?? null,
        ...(value.use === undefined ? [] : [value.use]),
      ]),
    );
    const id = submissionId(value.id);
    return once(id, async () => {
      let task = getTask(id);
      if (task && task.fingerprint !== fingerprint) throw new Problem(409, "提交编号已用于另一份任务");
      if (task && task.state !== "dispatching") return json({ id, state: task.state });
      if (!task) {
        const attachments = files([
          ...inputFiles,
          ...references.map((id) => {
            const item = db.prepare("SELECT name,content FROM knowledge WHERE id = ?").get(id);
            if (!item) throw new Problem(404, "没有该资料版本");
            return { name: item.name, data: Buffer.from(item.content as Uint8Array).toString("base64") };
          }),
        ]);
        if (value.mode === "api" && !gateway) throw new Problem(503, "统一 API 尚未配置");
        const candidates = devices
          .flatMap((device) => device.agents.map((agent) => ({ device, agent })))
          .filter(
            ({ device, agent }) =>
              (!value.node || device.name === value.node) &&
              (!value.agent || agent.id === value.agent) &&
              (!value.use || agent.use === value.use) &&
              (!value.mode || agent.mode === value.mode) &&
              (agent.mode === "local" || !!gateway),
          );
        if (!candidates.length) throw new Problem(409, "没有支持这种执行方式的电脑");
        const description = value.text.toLowerCase();
        const score = (profile: Profile) =>
          profile.keywords?.filter((word) => description.includes(word.toLowerCase())).length ?? 0;
        const available = (device: DeviceRecord) => {
          const last = seen.get(device.name);
          return last?.free && Date.now() - last.at < onlineFor;
        };
        candidates.sort(
          (a, b) =>
            score(b.agent) - score(a.agent) ||
            Number(!!available(b.device)) - Number(!!available(a.device)) ||
            Number(a.agent.mode === "api") - Number(b.agent.mode === "api") ||
            agentId(a.device.name, a.agent.id).localeCompare(agentId(b.device.name, b.agent.id)),
        );
        const { device, agent } = candidates[0];
        const input = JSON.stringify({ text: value.text, files: attachments, use: agent.use });
        db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, 'dispatching', NULL, ?)").run(
          id,
          fingerprint,
          device.name,
          agent.id,
          agent.mode,
          input,
          Date.now(),
        );
        task = getTask(id)!;
      }
      return dispatch(task);
    });
  }

  async function dispatch(task: Task) {
    const { id } = task;
    const type = agentId(task.node, task.agent);
    const reply = await upstream("POST", "/v1/events", "", { id, subject: id, type, summary: "个人任务" });
    if (reply.status !== 200) throw new Problem(503, "任务已保存，尚未收到中台接单确认");
    const routed = (reply.body as { routed?: unknown })?.routed;
    const state = Array.isArray(routed) && routed.includes(type) ? "queued" : "needs-attention";
    db.prepare("UPDATE tasks SET state = ? WHERE id = ? AND state = 'dispatching'").run(state, id);
    return json({ id, state: getTask(id)!.state }, 201);
  }

  async function retryPending() {
    for (const { id } of db
      .prepare("SELECT id FROM tasks WHERE state = 'dispatching' ORDER BY created LIMIT 20")
      .all()) {
      await once(String(id), async () => {
        const task = getTask(String(id))!;
        return task.state === "dispatching" ? dispatch(task) : json({});
      }).catch(() => {});
    }
  }

  async function revoke(run: number, attempt: number) {
    const lease = getClaim(run, attempt)?.lease;
    if (lease) {
      if (!gateway) throw new Problem(503, "需要原模型网关撤回凭据");
      await gateway.revoke((JSON.parse(lease) as Lease).key);
      db.prepare("UPDATE claims SET lease = NULL WHERE run = ? AND attempt = ?").run(run, attempt);
    }
  }

  async function work(url: URL, key: string, device: DeviceRecord) {
    seen.set(device.name, { at: Date.now(), free: url.searchParams.get("capacity") !== "0" });
    const reply = await upstream("GET", url.pathname + url.search, key);
    if (reply.status !== 200) {
      seen.delete(device.name);
      return reply;
    }
    const { job, cancel } = reply.body as { job: Run | null; cancel?: number[] };
    seen.set(device.name, { at: Date.now(), free: !job && url.searchParams.get("capacity") !== "0" });
    for (const run of cancel ?? []) {
      await once("claim:" + run, async () => {
        db.prepare("UPDATE claims SET stopping = 1 WHERE run = ? AND node = ? AND ack IS NULL").run(run, device.name);
        for (const old of db
          .prepare("SELECT attempt FROM claims WHERE run = ? AND node = ? AND lease IS NOT NULL")
          .all(run, device.name))
          await revoke(run, Number(old.attempt)).catch(() => {});
        return json({});
      });
    }
    if (!job) return reply;
    const subjects = [...new Set(job.context.events.map((event) => event.subject).filter((id) => taskName.test(id)))];
    const task = subjects.length === 1 ? getTask(subjects[0]) : undefined;
    const profile = task && device.agents.find((agent) => agent.id === task.agent);
    const assignedKind = task && JSON.parse(task.input).use;
    if (
      !task ||
      !profile ||
      task.node !== device.name ||
      profile.use !== job.agent.use ||
      (assignedKind && assignedKind !== profile.use) ||
      profile.mode !== task.mode ||
      job.agent.id !== agentId(task.node, task.agent)
    )
      throw new Problem(409, "领到的任务与机器配置不匹配");
    return once("claim:" + job.run, async () => {
      const latest = db.prepare("SELECT max(attempt) AS attempt FROM claims WHERE run = ?").get(job.run)?.attempt;
      if (typeof latest === "number" && latest > job.attempt) throw new Problem(409, "收到过期领单响应");
      for (const old of db
        .prepare("SELECT attempt FROM claims WHERE run = ? AND attempt < ? AND closed = 0")
        .all(job.run, job.attempt)) {
        await revoke(job.run, Number(old.attempt)).catch(() => {});
        db.prepare("UPDATE claims SET closed = 1 WHERE run = ? AND attempt = ?").run(job.run, Number(old.attempt));
      }
      db.prepare(
        `INSERT INTO claims (run,attempt,task,node,token) VALUES (?,?,?,?,?)
        ON CONFLICT(run,attempt) DO UPDATE SET token = excluded.token`,
      ).run(job.run, job.attempt, task.id, device.name, hash(job.token));
      db.prepare("UPDATE tasks SET run = ?, state = 'running' WHERE id = ?").run(job.run, task.id);
      return reply;
    });
  }

  async function perRun(req: IncomingMessage, device: DeviceRecord, run: number, attempt: number, action: string) {
    return once("claim:" + run, async () => {
      const claim = getClaim(run, attempt);
      const token = req.headers["x-run-token"];
      if (!claim || claim.node !== device.name || typeof token !== "string" || !equal(hash(token), claim.token))
        throw new Problem(403, "这一轮未授权给当前电脑");
      if (req.method === "POST" && action === "cleaned" && (claim.ack || claim.closed)) {
        await body(req);
        db.prepare("UPDATE claims SET cleaned = 1 WHERE run = ? AND attempt = ?").run(run, attempt);
        return json({ ok: true });
      }
      if (claim.closed) throw new Problem(410, "这一轮已失效");
      const task = getTask(claim.task)!;
      if (req.method === "GET" && action === "input") {
        if (claim.receipt || claim.stopping) throw new Problem(409, "这一轮已进入交付或停止");
        const previous = db
          .prepare(
            `SELECT run, attempt FROM claims WHERE task = ? AND ack IS NOT NULL
          AND (run < ? OR (run = ? AND attempt < ?)) ORDER BY run DESC, attempt DESC LIMIT 1`,
          )
          .get(task.id, run, run, attempt);
        const outputs = previous
          ? db
              .prepare("SELECT name,content FROM files WHERE run = ? AND attempt = ? ORDER BY name")
              .all(previous.run, previous.attempt)
          : [];
        return json({
          ...JSON.parse(task.input),
          id: task.id,
          mode: task.mode,
          agent: task.agent,
          previous: outputs.map((file) => ({
            name: file.name,
            data: Buffer.from(file.content as Uint8Array).toString("base64"),
          })),
        });
      }
      if (req.method === "POST" && action === "lease") {
        if (claim.receipt || claim.stopping || task.mode !== "api" || !gateway)
          throw new Problem(403, "这一轮没有统一 API 权限");
        let lease: Lease;
        if (claim.lease) lease = JSON.parse(claim.lease);
        else {
          const model = device.agents.find((agent) => agent.id === task.agent)?.model;
          lease = await gateway.issue("autoloop-" + task.id + "-" + run + "-" + attempt, model);
          db.prepare("UPDATE claims SET lease = ? WHERE run = ? AND attempt = ?").run(
            JSON.stringify(lease),
            run,
            attempt,
          );
        }
        return json(lease);
      }
      if (req.method !== "POST" || action !== "complete") throw new Problem(404, "没有这个入口");
      const value = await body(req);
      let result;
      try {
        parseResult(value?.result);
        result = value.result;
      } catch {
        throw new Problem(400, "回执无效");
      }
      const uploaded = files(value.files);
      const fingerprint = hash(JSON.stringify({ result, files: uploaded }));
      if (claim.receipt && claim.receipt !== fingerprint) throw new Problem(409, "这一轮已提交另一份交付");
      if (claim.ack) return json(JSON.parse(claim.ack));
      if (!claim.receipt) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const file of uploaded) {
            const content = Buffer.from(file.data, "base64");
            const id = hash(JSON.stringify([claim.task, run, attempt, file.name]));
            db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?)").run(
              id,
              claim.task,
              run,
              attempt,
              file.name,
              content,
              hash(content),
            );
          }
          db.prepare("UPDATE claims SET receipt = ? WHERE run = ? AND attempt = ?").run(fingerprint, run, attempt);
          db.prepare("UPDATE tasks SET state = 'returning' WHERE id = ? AND run = ?").run(claim.task, run);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      await revoke(run, attempt);
      const ack = await upstream("POST", `/v1/runs/${run}/result`, token, result);
      if (ack.status === 401 || ack.status === 404) {
        db.prepare("UPDATE claims SET closed = 1 WHERE run = ? AND attempt = ?").run(run, attempt);
        throw new Problem(410, "中台已撤销这一轮");
      }
      if (ack.status !== 200) return ack;
      const rejected = (ack.body as { rejected?: unknown[] })?.rejected;
      const state = rejected?.length
        ? "needs-attention"
        : Array.isArray(result.ask) && result.ask.length
          ? "waiting-review"
          : result.outcome;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE claims SET ack = ? WHERE run = ? AND attempt = ?").run(
          JSON.stringify(ack.body),
          run,
          attempt,
        );
        db.prepare("UPDATE tasks SET state = ? WHERE id = ? AND run = ?").run(state, claim.task, run);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return ack;
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, "http://localhost");
    const key = bearer(req);
    const method = req.method!;
    const path = url.pathname;
    if (method === "GET" && path === "/healthz") return json({ ok: true });
    if (key && equal(key, owner)) {
      if (method === "POST" && path === "/personal/tasks") return submit(await body(req));
      if (method === "GET" && path === "/personal/knowledge")
        return json(
          db
            .prepare("SELECT id,name,created,length(content) AS bytes FROM knowledge ORDER BY created DESC LIMIT 100")
            .all(),
        );
      if (method === "POST" && path === "/personal/knowledge") {
        const stored = files((await body(req))?.files).map(({ name, data }) => {
          const id = hash(JSON.stringify([name, data]));
          db.prepare("INSERT OR IGNORE INTO knowledge VALUES (?, ?, ?, ?)").run(
            id,
            name,
            Buffer.from(data, "base64"),
            Date.now(),
          );
          return { id, name };
        });
        return json(stored, 201);
      }
      if (method === "GET" && path === "/personal/tasks")
        return json({
          tasks: db
            .prepare(
              `SELECT id,node,agent,mode,state,run,created,json_extract(input, '$.use') AS use,
          substr(json_extract(input, '$.text'), 1, 80) AS title FROM tasks ORDER BY created DESC LIMIT 100`,
            )
            .all(),
          devices: devices.map(({ name, agents }) => ({
            name,
            agents,
            online: Date.now() - (seen.get(name)?.at ?? 0) < onlineFor,
          })),
        });
      const taskPath = /^\/personal\/tasks\/(personal-[a-f0-9]{24})(?:\/files\/([a-f0-9]{64}))?$/.exec(path);
      if (method === "GET" && taskPath) {
        const task = getTask(taskPath[1]);
        if (!task) throw new Problem(404, "没有该任务");
        if (!taskPath[2])
          return json({
            ...task,
            use: JSON.parse(task.input).use,
            input: undefined,
            fingerprint: undefined,
            files: listFiles(task.id),
            cleanup: db
              .prepare("SELECT run,attempt,cleaned FROM claims WHERE task = ? AND ack IS NOT NULL ORDER BY run,attempt")
              .all(task.id),
          });
        const file = db
          .prepare(
            `SELECT content,name FROM files JOIN claims USING (run,attempt)
          WHERE files.task = ? AND files.id = ? AND claims.ack IS NOT NULL`,
          )
          .get(task.id, taskPath[2]);
        if (!file) throw new Problem(404, "没有该成果");
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-disposition":
            "attachment; filename*=UTF-8''" + encodeURIComponent(String(file.name)).replaceAll("'", "%27"),
        });
        res.end(Buffer.from(file.content as Uint8Array));
        return;
      }
      throw new Problem(404, "没有这个入口");
    }
    const device = key && devices.find((item) => equal(item.keyHash, hash(key)));
    if (!device) throw new Problem(401, "需要登录");
    if (method === "GET" && path === "/v1/work") return work(url, key, device);
    const parts = path.split("/");
    if (
      parts.length === 6 &&
      parts[1] === "personal" &&
      parts[2] === "runs" &&
      number.test(parts[3]) &&
      number.test(parts[4])
    )
      return perRun(req, device, Number(parts[3]), Number(parts[4]), parts[5]);
    throw new Problem(404, "没有这个入口");
  }

  const http = createServer(async (req, res) => {
    let reply: Reply | undefined;
    try {
      reply = await handle(req, res);
    } catch (error) {
      reply =
        error instanceof Problem
          ? json({ error: error.message }, error.status)
          : json({ error: "服务暂时不可用" }, 503);
    }
    if (reply) {
      if (!req.complete) res.setHeader("connection", "close");
      res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(reply.body));
    }
  });
  return {
    http,
    submit,
    retryPending,
    known(id: string) {
      const task = getTask(submissionId(id));
      return task && { id: task.id, state: task.state };
    },
    async close() {
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeIdleConnections();
      });
      db.close();
    },
  };
}
