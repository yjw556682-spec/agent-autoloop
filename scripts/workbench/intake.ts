import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

export class IntakeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
type Input = { link: string; plan?: string };
type Result = { message: string };
const exec = promisify(execFile);

function feishuLink(input: unknown): input is string {
  if (typeof input !== "string" || input.length > 2048) return false;
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

/** This is only an intake bridge. Durable deduplication and dispatch belong to the source and hub. */
export function createBootcampIntake(execute: (input: Input) => Promise<string>) {
  const active = new Map<string, Promise<Result>>();
  return async (value: unknown): Promise<Result> => {
    const input = value as Partial<Input> | null;
    if (!feishuLink(input?.link) || (input?.plan !== undefined && input.plan !== "" && !feishuLink(input.plan))) {
      throw new IntakeError(400, "请填写有效的 HTTPS 飞书任务或方案文档链接。");
    }
    const normalized = { link: input.link, ...(input.plan && { plan: input.plan }) };
    const key = JSON.stringify(normalized);
    const existing = active.get(key);
    if (existing) return existing;
    // Bound child processes; this map is not a second task queue.
    if (active.size >= 2) throw new IntakeError(429, "正在读取其他任务，请稍后再提交。");
    const job = (async () => {
      let stdout: string;
      try {
        stdout = await execute(normalized);
      } catch {
        throw new IntakeError(
          502,
          "飞书任务未确认接单。请先查看运行记录，再核对飞书登录和链接访问权限；有多份方案时请指定一份。",
        );
      }
      const message = stdout.trim();
      if (!/^交给了[：:]/m.test(message))
        throw new IntakeError(409, "当前没有规则确认接收实训营任务，请检查规则与暂停状态。");
      return { message };
    })();
    active.set(key, job);
    try {
      return await job;
    } finally {
      if (active.get(key) === job) active.delete(key);
    }
  };
}

export function bootcampIntake(home: string) {
  return createBootcampIntake(async ({ link, plan }) => {
    const { stdout } = await exec(
      "pwsh.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(home, "Submit-Bootcamp.ps1"),
        "-Link",
        link,
        ...(plan ? ["-PlanLink", plan] : []),
      ],
      { windowsHide: true, timeout: 90_000, maxBuffer: 1024 * 1024 },
    );
    return stdout;
  });
}
