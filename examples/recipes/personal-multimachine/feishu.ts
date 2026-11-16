import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { commandLine } from "../../../host/command.ts";
import { canonicalLink } from "../bootcamp-team/core.ts";
import { hash, Problem, safeName } from "./data.ts";

type Identity = { group: string; owner: string; bot: string };
export type Feishu = Identity & {
  program: string;
  profile?: string;
  route?: { node: string; agent: string; knowledge?: string[]; instruction?: string; link?: string };
};
type DeliveryQueue = {
  pending(target: string): { id: string; files: { id: string; name: string }[] }[];
  read(item: string): Buffer;
  mark(task: string, item: string): void;
};
type Submission = NonNullable<Awaited<ReturnType<typeof readSubmission>>> & {
  node?: string;
  agent?: string;
  knowledge?: string[];
};
type Document = { document_id?: string; revision_id?: number | string; content?: string };
type Message = {
  chat_id?: string;
  chat_type?: string;
  sender_id?: string;
  sender_type?: string;
  message_type?: string;
  message_id?: string;
  content?: string;
  mentions?: { id: string; key?: string }[];
};

function intent(message: Message, identity: Identity) {
  if (
    message.chat_id !== identity.group ||
    message.chat_type !== "group" ||
    message.sender_id !== identity.owner ||
    message.sender_type !== "user" ||
    message.message_type !== "text" ||
    !/^om_[\w-]+$/.test(message.message_id ?? "") ||
    !Array.isArray(message.mentions) ||
    typeof message.content !== "string"
  )
    return null;
  const mention = message.mentions.find((person) => person?.id === identity.bot);
  if (!mention) return null;
  const text = (mention.key ? message.content.replace(mention.key, "") : message.content).trim();
  if (!text || text.length > 100_000) return null;
  return { id: "feishu:" + message.message_id, text };
}

export async function readSubmission(
  message: Message,
  identity: Identity,
  read: (url: string) => Promise<Document>,
  requiredLink?: string,
) {
  const request = intent(message, identity);
  if (!request) return null;
  const links = new Set<string>();
  for (const match of request.text.matchAll(/https:\/\/[^\s<>[\]()\u3000-\u303f\uff00-\uffef]+/giu)) {
    const link = match[0].replace(/[),.;!\]}]+$/, "");
    const parsed = new URL(link);
    if (!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(parsed.hostname)) continue;
    if (requiredLink && parsed.origin + parsed.pathname.replace(/\/$/, "") !== requiredLink) continue;
    if (!/^\/(docx|wiki)\//.test(parsed.pathname)) throw new Problem(400, "请附上可授权给机器人的飞书方案文档链接");
    links.add(canonicalLink(link));
  }
  if (requiredLink && !links.size) return null;
  if (links.size > 8) throw new Problem(400, "一次最多提交八份飞书资料");
  const files = [];
  for (const url of links) {
    const doc = await read(url);
    if (!doc?.document_id || !doc.content?.trim()) throw new Problem(403, "机器人尚未取得方案读取权限");
    files.push({
      name: `飞书资料-${files.length + 1}.md`,
      data: Buffer.from(
        `来源：${url}\n文档：${doc.document_id}\n版本：${doc.revision_id ?? "未返回"}\n\n${doc.content}`,
      ).toString("base64"),
    });
  }
  return { ...request, files };
}

export function feishuTarget(identity: Identity) {
  return hash(JSON.stringify([identity.group, identity.owner, identity.bot]));
}

function cliEnv(config: Feishu) {
  return {
    ...process.env,
    ...(config.profile && { LARKSUITE_CLI_CONFIG_DIR: config.profile }),
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  };
}

function checkIdentity(config: Feishu) {
  if (
    !/^oc_[\w-]+$/.test(config.group) ||
    !/^ou_[\w-]+$/.test(config.owner) ||
    !/^ou_[\w-]+$/.test(config.bot) ||
    !config.program ||
    config.bot === config.owner
  )
    throw new Error("飞书需要明确配置任务群、本人和机器人身份");
}

function botCLI(config: Feishu, signal: AbortSignal) {
  const env = cliEnv(config);
  return async (args: string[], input = "", cwd?: string) => {
    const [program, words] = commandLine([config.program, ...args]);
    const output = await new Promise<string>((resolve, reject) => {
      const process = execFile(
        program,
        words,
        { cwd, env, signal, windowsHide: true, timeout: 45_000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => (error ? reject(new Error("飞书请求未成功")) : resolve(stdout)),
      );
      process.stdin?.on("error", () => {});
      process.stdin?.end(input);
    });
    const result = JSON.parse(output);
    if (result.ok !== true || result.identity !== "bot") throw new Error("飞书未返回机器人身份的成功结果");
    return result.data;
  };
}

function privateNotice(cli: ReturnType<typeof botCLI>, owner: string, message: string, id: string) {
  return cli(
    [
      "im",
      "+messages-send",
      "--user-id",
      owner,
      "--as",
      "bot",
      "--msg-type",
      "text",
      "--idempotency-key",
      hash(id).slice(0, 40),
      "--content",
      "-",
    ],
    JSON.stringify({ text: message }),
  );
}

export async function deliverFeishu(config: Feishu, signal: AbortSignal, queue: DeliveryQueue) {
  checkIdentity(config);
  const cli = botCLI(config, signal);
  for (const task of queue.pending(feishuTarget(config))) {
    if (signal.aborted) return;
    const directory = await mkdtemp(join(tmpdir(), "autoloop-feishu-"));
    try {
      for (const file of task.files) {
        const name = safeName(file.name);
        await writeFile(join(directory, name), queue.read(file.id), { mode: 0o600 });
        const sent = await cli(
          [
            "im",
            "+messages-send",
            "--as",
            "bot",
            "--user-id",
            config.owner,
            "--file",
            "./" + name,
            "--idempotency-key",
            hash(task.id + ":" + file.id).slice(0, 40),
          ],
          "",
          directory,
        );
        if (!sent?.message_id) throw new Error("飞书没有确认附件已发送");
        queue.mark(task.id, file.id);
      }
      const receipt = await privateNotice(
        cli,
        config.owner,
        `任务 ${task.id} 已完成。打开小镇「个人任务 → 用任务编号找成果」，可查看本轮归档。`,
        task.id + ":receipt",
      );
      if (!receipt?.message_id) throw new Error("飞书没有确认回执已发送");
      queue.mark(task.id, "receipt");
    } catch {
      if (!signal.aborted) console.error(`飞书私聊交付待重试：${task.id}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export async function listenFeishu(
  config: Feishu,
  signal: AbortSignal,
  submit: (task: Submission, target: string) => Promise<{ status: number; body: unknown }>,
  known: (id: string) => { id: string; state: string } | undefined,
) {
  checkIdentity(config);
  const target = feishuTarget(config);
  const cli = botCLI(config, signal);
  const env = cliEnv(config);
  const notify = (message: string, id: string) => privateNotice(cli, config.owner, message, id);
  while (!signal.aborted) {
    const [program, args] = commandLine([config.program, "event", "consume", "im.message.receive_v1", "--as", "bot"]);
    const child = spawn(program, args, { env, signal, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let ready = false;
    const status = createInterface({ input: child.stderr });
    status.on("line", (line) => {
      if (line === "[event] ready event_key=im.message.receive_v1") {
        ready = true;
        console.log("飞书群任务入口已连接");
      }
    });
    for await (const line of createInterface({ input: child.stdout })) {
      if (signal.aborted) break;
      let event: Message;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const request = event && intent(event, config);
      if (!request) continue;
      const route = config.route;
      if (route?.link && !request.text.includes(route.link)) continue;
      try {
        let result = known(request.id);
        if (!result) {
          const received = await readSubmission(
            event,
            config,
            async (url) => {
              const data = await cli(["docs", "+fetch", "--doc", url, "--doc-format", "markdown", "--as", "bot"]);
              return data.document;
            },
            route?.link,
          );
          if (!received) continue;
          const text = route?.instruction
            ? route.instruction + "\n\n本人在飞书提交的要求：\n" + received.text
            : received.text;
          const reply = await submit(
            { ...received, text, node: route?.node, agent: route?.agent, knowledge: route?.knowledge },
            target,
          );
          if (reply.status >= 300) throw new Error("中台没有确认接单");
          result = reply.body as { id: string; state: string };
        }
        await notify(`已收到任务 ${result.id}。请在小镇查看进度。`, request.id + ":accepted");
      } catch {
        await notify(
          "飞书任务暂未确认接单。请检查方案是否授权给机器人，或到小镇查看是否已入队。",
          `${event.message_id}:check`,
        ).catch(() => {});
      }
    }
    await closed;
    if (!signal.aborted) {
      console.error(ready ? "飞书连接中断，稍后重连" : "飞书连接未就绪，请检查群消息权限和机器人配置");
      await wait(5000, undefined, { signal }).catch(() => {});
    }
  }
}
