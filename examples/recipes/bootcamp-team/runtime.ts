import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ack, Event } from "./core.ts";
import type { TeamOptions } from "./rules.ts";

export type Settings = TeamOptions & { larkCommand: string };
export const settings = async (file: string): Promise<Settings> => JSON.parse(await readFile(file, "utf8"));
export async function emitter(home: string) {
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  const url = new URL(config.url);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !config.source?.key ||
    config.source.name !== "local"
  )
    throw new Error("该本机配方需要回环中台地址和已配置的本机来源");
  return async (event: Event): Promise<Ack> => {
    const response = await fetch(new URL("/v1/events", url), {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${config.source.key}`, "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`中台接单失败（${response.status}）`);
    return (await response.json()) as Ack;
  };
}
export function output(text: string, receipt: object = {}) {
  console.log(`${text}\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``);
}
