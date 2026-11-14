// The registry is an explicit allowlist and a source checkpoint, never a second work queue.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type Snapshot = {
  source: string;
  taskGuid?: string;
  taskTitle?: string;
  taskDescription?: string;
  planUrl: string;
  planDocumentId: string;
  planRevision?: string | number;
  planMarkdown: string;
};
export type Target = {
  link: string;
  plan?: string;
  fingerprint: string;
  enabled: boolean;
  checkedAt: string;
  lastCase?: string;
  pending?: { fingerprint: string; attempt: number };
};
type Registry = { version: 1; targets: Record<string, Target> };
export type Event = { id: string; type: string; subject: string; summary: string; link: string };
export type Ack = { event: number; routed: string[]; paused?: string[]; duplicate?: boolean };
type Emit = (event: Event) => Promise<Ack>;
export type IntakeResult = {
  autoloopIntake: 1;
  status: "baseline" | "unchanged" | "queued" | "paused";
  caseId?: string;
  message: string;
};
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function canonicalLink(value: string): string {
  const url = new URL(value);
  if (
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)
  )
    throw new Error("请提供 HTTPS 飞书任务或方案链接");
  const document = /^\/(docx|wiki)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (document) return `${url.origin}/${document[1]}/${document[2]}`;
  const guid = url.searchParams.get("guid");
  if (
    url.pathname.replace(/\/$/, "") === "/client/todo/task" &&
    guid &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(guid)
  )
    return `${url.origin}/client/todo/task?guid=${guid.toLowerCase()}`;
  throw new Error("仅支持飞书任务、docx 或 wiki 方案链接");
}

export function fingerprint(snapshot: Snapshot) {
  return hash(
    JSON.stringify([
      canonicalLink(snapshot.source),
      snapshot.taskGuid ?? "",
      snapshot.taskTitle ?? "",
      snapshot.taskDescription ?? "",
      canonicalLink(snapshot.planUrl),
      snapshot.planDocumentId,
      snapshot.planMarkdown,
    ]),
  );
}

export async function registry(root: string): Promise<Registry> {
  try {
    const value = JSON.parse(await readFile(join(root, "watch.json"), "utf8"));
    if (value.version !== 1 || !value.targets || typeof value.targets !== "object" || Array.isArray(value.targets))
      throw new Error("登记文件格式错误");
    for (const target of Object.values(value.targets) as Target[]) {
      canonicalLink(target.link);
      if (target.plan) canonicalLink(target.plan);
      if (typeof target.fingerprint !== "string" || typeof target.enabled !== "boolean")
        throw new Error("登记记录不完整");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, targets: {} };
    throw error;
  }
}

async function save(root: string, data: Registry) {
  const file = join(root, "watch.json");
  await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

// Manual submissions and the scheduled collector really can overlap on this machine.
async function locked<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const lock = join(root, ".intake.lock");
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      try {
        return await work();
      } finally {
        await rm(lock, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(await readFile(lock, "utf8"));
        if (pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (check) {
            if ((check as NodeJS.ErrnoException).code === "ESRCH")
              throw new Error("上次提交意外中断；请确认没有提交进程后清理 .intake.lock，再重试");
          }
        }
      } catch (check) {
        if ((check as NodeJS.ErrnoException).code !== "ENOENT") throw check;
      }
      await delay(100);
    }
  }
  throw new Error("另一份提交尚未结束，请稍后重试");
}

export async function receiveSnapshot(
  root: string,
  snapshot: Snapshot,
  emit: Emit,
  mode: "submit" | "baseline" = "submit",
): Promise<IntakeResult> {
  const link = canonicalLink(snapshot.source);
  const plan = canonicalLink(snapshot.planUrl);
  if (!/\/(docx|wiki)\//.test(plan) || !snapshot.planDocumentId || !snapshot.planMarkdown?.trim())
    throw new Error("方案正文为空或读取不完整");
  return locked(root, async () => {
    const data = await registry(root);
    const key = hash(link);
    const next = fingerprint(snapshot);
    const current = data.targets[key];
    const target: Target = current ?? { link, plan, fingerprint: "", enabled: true, checkedAt: "" };
    target.checkedAt = new Date().toISOString();
    target.plan = plan;
    data.targets[key] = target;
    if (mode === "baseline") {
      if (current) throw new Error("该链接已经登记，不能用重新建基线跳过尚未处理的变更");
      target.fingerprint = next;
      await save(root, data);
      return { autoloopIntake: 1, status: "baseline", message: "已登记当前版本；本次不启动制作，后续内容变更才处理。" };
    }
    if (target.fingerprint === next) {
      await save(root, data);
      return {
        autoloopIntake: 1,
        status: "unchanged",
        caseId: target.lastCase,
        message: "资料内容没有变化，已避免重复制作。",
      };
    }
    // Persist the opt-in before delivery; an uncertain response must remain retryable.
    if (target.pending?.fingerprint !== next) target.pending = { fingerprint: next, attempt: 0 };
    await save(root, data);
    const caseId = `bootcamp-${next.slice(0, 24)}`;
    const folder = join(root, "cases", caseId);
    await mkdir(join(folder, "drafts"), { recursive: true });
    const input = join(folder, "input.json");
    try {
      if (fingerprint(JSON.parse(await readFile(input, "utf8"))) !== next)
        throw new Error("已有案例快照与来源内容不一致，请检查后重试");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(`${input}.tmp`, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await rename(`${input}.tmp`, input);
    }
    const ack = await emit({
      id: target.pending.attempt ? `${caseId}:retry-${target.pending.attempt}` : caseId,
      type: "bootcamp.pipeline.requested",
      subject: caseId,
      summary: "已登记实训营资料待制作本地草稿",
      link,
    });
    // Acknowledged unrouted IDs cannot be rerouted by resending: upstream deduplicates them forever.
    if (Number.isInteger(ack.event) && ack.routed.length === 0 && !ack.paused?.length) {
      target.pending.attempt++;
      await save(root, data);
    }
    if (
      !Number.isInteger(ack.event) ||
      (!ack.routed.includes("实训营·资料统筹") && !ack.paused?.includes("实训营·资料统筹"))
    )
      throw new Error("资料已保存，但统筹规则没有确认接收，请检查规则后重试");
    target.fingerprint = next;
    target.lastCase = caseId;
    delete target.pending;
    target.plan = plan;
    await save(root, data);
    const paused = ack.paused?.includes("实训营·资料统筹") === true;
    return {
      autoloopIntake: 1,
      status: paused ? "paused" : "queued",
      caseId,
      message: paused
        ? "事件已保存，但统筹规则已暂停；恢复后请在运行记录补跑此事件。"
        : "已交给资料统筹；三份本地草稿完成后会汇总检查，等待你审核。",
    };
  });
}

export async function watchRegistered(root: string, collect: (target: Target) => Promise<Snapshot>, emit: Emit) {
  const results: IntakeResult[] = [];
  const errors: string[] = [];
  for (const target of Object.values((await registry(root)).targets).filter((entry) => entry.enabled)) {
    try {
      const snapshot = await collect(target);
      if (canonicalLink(snapshot.source) !== target.link) throw new Error("读取结果与登记来源不一致");
      results.push(await receiveSnapshot(root, snapshot, emit));
    } catch {
      errors.push(target.link);
    }
  }
  return { results, errors };
}
