import { readFile } from "node:fs/promises";
import { collect, reader } from "./collect.ts";
import { watchRegistered } from "./core.ts";
import { emitter, output, settings } from "./runtime.ts";

const config = await settings(process.argv[2]);
const context = JSON.parse(await readFile(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
const title = "请恢复已登记飞书资料的读取";
const open = context.open.filter((card: { title: string }) => card.title === title);
if (open.length && !context.answers.length) {
  output("没事可做：等待本人恢复资料读取后答复卡片。");
  process.exit(0);
}
const result = await watchRegistered(
  config.workspace,
  (target) => collect(target, reader(config.larkCommand)),
  await emitter(config.home),
);
if (result.errors.length) {
  output(
    `有 ${result.errors.length} 份已登记资料未能确认读取或接单，原检查点保留。`,
    open.length
      ? {}
      : {
          ask: [
            {
              key: "bootcamp-watch-read",
              title,
              text: "请检查飞书本人登录、链接访问权限或本机中台。成功资料已处理；后续自动读取等你检查并答复此卡片，失败资料保留原版本。",
              options: ["已检查，重试"],
              recommend: 0,
              about: "只重试已登记链接，不扩大监听范围。",
            },
          ],
        },
  );
} else {
  const changed = result.results.filter((item) => item.status !== "unchanged").length;
  output(changed ? `已接收 ${changed} 份资料变更。` : "没事可做：已登记资料没有内容变化。", {
    ...(open.length
      ? { resolve: open.map((card: { card: number }) => ({ card: card.card, reason: "已登记资料读取和接单恢复正常" })) }
      : {}),
  });
}
