import { createHash, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a), "hex"), Buffer.from(hash(b), "hex"));
export const label = /^[a-z][a-z0-9-]{0,26}$/;
export const number = /^[1-9][0-9]{0,12}$/;
export const taskName = /^personal-[a-f0-9]{24}$/;
export const maxBytes = 24 * 1024 * 1024;
export type Mode = "local" | "api";
export const agentNames = { codex: "Codex", claude: "Claude Code", zcode: "ZCode" } as const;
export type AgentKind = keyof typeof agentNames;
export type Profile = { id: string; use: AgentKind; mode: Mode; model?: string; keywords?: string[] };
export function supportsAgent(profile: Profile) {
  return (
    Object.hasOwn(agentNames, profile.use) &&
    (profile.mode === "api" || (profile.mode === "local" && profile.use !== "zcode")) &&
    (profile.model === undefined || (typeof profile.model === "string" && /^[\w][\w./:-]{0,127}$/.test(profile.model)))
  );
}
export const agentId = (node: string, profile: string) => `personal-${node}--${profile}`;
export type FileInput = { name: string; data: string };
export type Run = {
  run: number;
  attempt: number;
  token: string;
  agent: { id: string; use: string };
  context: { events: { subject: string }[] };
};

export class Problem extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function safeName(name: unknown): string {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 150 ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(name) ||
    /^[.]|[. ]$/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) ||
    name !== name.normalize("NFC")
  )
    throw new Problem(400, "文件名无效");
  return name;
}

export function files(value: unknown): FileInput[] {
  if (!Array.isArray(value) || value.length > 32) throw new Problem(400, "一次最多传输 32 份文件");
  let bytes = 0;
  const names = new Set<string>();
  return value.map((file) => {
    const name = safeName(file?.name);
    const data = file?.data;
    if (typeof data !== "string" || data.length > maxBytes * 1.4) throw new Problem(400, "文件内容无效");
    const raw = Buffer.from(data, "base64");
    if (raw.toString("base64") !== data) throw new Problem(400, "文件编码无效");
    bytes += raw.length;
    if (bytes > maxBytes) throw new Problem(413, "一次最多传输 24 MB");
    const key = name.toLowerCase();
    if (names.has(key)) throw new Problem(400, "文件名重复");
    names.add(key);
    return { name, data };
  });
}

export function baseUrl(value: string, allowLoopback = false) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw new Error("请输入 HTTPS 服务地址");
  return url.origin;
}
