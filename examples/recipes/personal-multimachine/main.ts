import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { privateDirectory } from "../../../host/files.ts";
import { createWorker } from "../../../worker/worker.ts";
import type { Job } from "../../../protocol/job.ts";
import { call, captureAnswer, finishRun, prepareRun, reportCleanup, type Device } from "./device.ts";
import { baseUrl, label, supportsAgent } from "./data.ts";
import { liteLLM } from "./gateway.ts";
import { connectHub, personalRules, type ServiceConfig } from "./config.ts";
import { createPersonalServer } from "./server.ts";
import { listenFeishu } from "./feishu.ts";

const [command, file] = process.argv.slice(2);
const config = file && JSON.parse(await readFile(file, "utf8"));
if (command === "rules" && config) {
  console.log(JSON.stringify(personalRules(config.devices, config.channel), null, 2));
} else if (command === "server" && config) {
  const settings: ServiceConfig = config;
  if (!isAbsolute(settings.directory)) throw new Error("服务数据目录必须是绝对路径");
  privateDirectory(settings.directory);
  const server = createPersonalServer({
    ...settings,
    database: join(settings.directory, "personal.sqlite"),
    upstream: connectHub(settings),
    gateway: settings.gateway && liteLLM(settings.gateway, settings.allowLoopback),
  });
  server.http.listen(settings.port ?? 3352, "127.0.0.1", () => console.log("个人多机服务已启动"));
  const signal = new AbortController();
  let retrying: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (!retrying)
      retrying = server.retryPending().finally(() => {
        retrying = undefined;
      });
  }, 5000);
  const listening = settings.feishu && listenFeishu(settings.feishu, signal.signal, server.submit, server.known);
  listening?.catch(() => {
    console.error("飞书入口配置无效");
  });
  const stop = async () => {
    clearInterval(timer);
    signal.abort();
    await listening?.catch(() => {});
    await retrying;
    await server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} else if (command === "worker" && config) {
  const device: Device = config;
  const capacity = device.capacity ?? 1;
  if (
    !label.test(device.name) ||
    device.name.includes("--") ||
    !device.key ||
    !Array.isArray(device.agents) ||
    !device.agents.length ||
    new Set(device.agents.map((agent) => agent.id)).size !== device.agents.length ||
    device.agents.some(
      (agent) =>
        !label.test(agent.id) ||
        agent.id.includes("--") ||
        !isAbsolute(agent.program) ||
        !supportsAgent(agent) ||
        (agent.use === "zcode" && agent.isolatedHost !== true) ||
        (agent.args && (!Array.isArray(agent.args) || !agent.args.every((arg) => typeof arg === "string"))),
    ) ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 8 ||
    !process.env.AGENT_AUTOLOOP_HOME
  )
    throw new Error("需要专用执行目录、机器身份及有效的 Agent 配置。ZCode 需在隔离环境中使用统一 API。");
  baseUrl(device.url, device.allowLoopback);
  privateDirectory(process.env.AGENT_AUTOLOOP_HOME);
  const worker = createWorker({
    name: device.name,
    capacity,
    log: (line) => console.log(line),
    hub: {
      work: ({ claim, wait, running, capacity }) =>
        call(
          device,
          "/v1/work?" +
            new URLSearchParams({
              claim,
              wait: String(wait),
              running: running.join(","),
              capacity: capacity ? "1" : "0",
            }),
        ),
      started: async () => ({}),
      result: () => Promise.reject(new Error("个人任务通过交付接口提交")),
    },
    isolated: {
      prepare: (job: Job, dir) => prepareRun(device, job, dir),
      capture: captureAnswer,
      complete: (job, dir, result) => finishRun(device, job, dir, result),
      cleaned: (job) => reportCleanup(device, job),
    },
  });
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  await worker.run(stop.signal);
} else {
  console.error("用法：node main.ts <rules|server|worker> 配置文件");
  process.exitCode = 1;
}
