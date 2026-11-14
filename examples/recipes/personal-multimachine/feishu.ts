import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { commandLine } from "../../../host/command.ts";
import { canonicalLink } from "../bootcamp-team/core.ts";
import { hash, Problem } from "./data.ts";

type Identity = { group: string; owner: string; bot: string };
export type Feishu = Identity & { program: string; profile?: string };
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

export async function readSubmission(message: Message, identity: Identity, read: (url: string) => Promise<Document>) {
  const request = intent(message, identity);
  if (!request) return null;
  const links = new Set<string>();
  for (const match of request.text.matchAll(/https:\/\/[^\s<>\u3000-\u303f\uff00-\uffef]+/giu)) {
    const link = match[0].replace(/[),.;!\]}]+$/, "");
    const parsed = new URL(link);
    if (!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(parsed.hostname)) continue;
    if (!/^\/(docx|wiki)\//.test(parsed.pathname)) throw new Problem(400, "请附上可授权给机器人的飞书方案文档链接");
    links.add(canonicalLink(link));
  }
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

export async function listenFeishu(
  config: Feishu,
  signal: AbortSignal,
  submit: (task: {
    id: string;
    text: string;
    files: { name: string; data: string }[];
  }) => Promise<{ status: number; body: unknown }>,
  known: (id: string) => { id: string; state: string } | undefined,
) {
  if (
    !/^oc_[\w-]+$/.test(config.group) ||
    !/^ou_[\w-]+$/.test(config.owner) ||
    !/^ou_[\w-]+$/.test(config.bot) ||
    !config.program ||
    config.bot === config.owner
  )
    throw new Error("飞书需要明确配置任务群、本人和机器人身份");
  const env = {
    ...process.env,
    ...(config.profile && { LARKSUITE_CLI_CONFIG_DIR: config.profile }),
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  };
  async function cli(args: string[], input = "") {
    const [program, words] = commandLine([config.program, ...args]);
    const output = await new Promise<string>((resolve, reject) => {
      const process = execFile(
        program,
        words,
        { env, signal, windowsHide: true, timeout: 25_000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => (error ? reject(new Error("飞书请求未成功")) : resolve(stdout)),
      );
      process.stdin?.on("error", () => {});
      process.stdin?.end(input);
    });
    const result = JSON.parse(output);
    if (result.ok !== true || result.identity !== "bot") throw new Error("飞书未返回机器人身份的成功结果");
    return result.data;
  }
  const notify = (where: string[], message: string, id: string) =>
    cli(
      [
        "im",
        "+messages-send",
        ...where,
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
      try {
        let result = known(request.id);
        if (!result) {
          const received = await readSubmission(event, config, async (url) => {
            const data = await cli(["docs", "+fetch", "--doc", url, "--doc-format", "markdown", "--as", "bot"]);
            return data.document;
          });
          if (!received) continue;
          result = (await submit(received)).body as { id: string; state: string };
        }
        await notify(
          ["--chat-id", config.group],
          `已收到任务 ${result.id}。请在小镇查看进度。`,
          request.id + ":accepted",
        );
      } catch {
        await notify(
          ["--user-id", config.owner],
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
