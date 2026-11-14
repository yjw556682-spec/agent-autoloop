import { collect, reader } from "./collect.ts";
import { receiveSnapshot } from "./core.ts";
import { emitter, settings } from "./runtime.ts";

try {
  const config = await settings(process.argv[2]);
  const mode = process.argv.includes("--baseline") ? "baseline" : "submit";
  const args = process.argv.slice(3).filter((arg) => arg !== "--baseline");
  if (!args[0] || args.length > 2) throw new Error("用法：intake.ts 配置文件 任务或方案链接 [方案链接] [--baseline]");
  const snapshot = await collect({ link: args[0], plan: args[1] }, reader(config.larkCommand));
  console.log(JSON.stringify(await receiveSnapshot(config.workspace, snapshot, await emitter(config.home), mode)));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
