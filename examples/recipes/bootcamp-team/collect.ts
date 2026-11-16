// Read one explicitly submitted source. Never enumerate the user's tasks or documents.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalLink, type Snapshot, type Target } from "./core.ts";

const execute = promisify(execFile);
type Task = {
  guid: string;
  summary?: string;
  description?: string;
  attachments?: { url?: string }[];
  attachment_deliveries?: { url?: string }[];
};
export function reader(command: string) {
  return async (args: string[]): Promise<Record<string, any>> => {
    let stdout: string;
    try {
      ({ stdout } = await execute(command, [...args, "--as", "user"], {
        windowsHide: true,
        timeout: 25_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
      }));
    } catch {
      throw new Error("飞书读取失败，请检查本人登录、网络和该链接的访问权限");
    }
    const response = JSON.parse(stdout);
    if (response.ok !== true || response.identity !== "user" || !response.data)
      throw new Error("飞书未返回完整的本人读取结果");
    return response.data;
  };
}

export async function collect(
  target: Pick<Target, "link" | "plan">,
  read: ReturnType<typeof reader>,
): Promise<Snapshot> {
  const source = canonicalLink(target.link);
  const guid = new URL(source).searchParams.get("guid");
  let plan = target.plan ? canonicalLink(target.plan) : undefined;
  let task: Task | undefined;
  if (guid) {
    task = (await read(["task", "tasks", "get", "--task-guid", guid])).task as Task;
    if (task?.guid !== guid) throw new Error("任务读取结果与提交链接不一致");
    if (!plan) {
      const candidates = [
        ...(task.description?.match(
          /https:\/\/(?:[a-z0-9-]+\.)*(?:feishu\.cn|larksuite\.com)\/(?:docx|wiki)\/[A-Za-z0-9]+/gi,
        ) ?? []),
        ...[...(task.attachments ?? []), ...(task.attachment_deliveries ?? [])].flatMap((item) =>
          item.url ? [item.url] : [],
        ),
      ];
      const valid = new Set<string>();
      for (const candidate of candidates) {
        try {
          const url = canonicalLink(candidate);
          if (/\/(docx|wiki)\//.test(url)) valid.add(url);
        } catch {
          /* Non-document attachments are data only. */
        }
      }
      if (valid.size !== 1) throw new Error("任务里没有唯一的方案文档，请同时指定方案链接");
      plan = [...valid][0];
    }
  } else {
    if (plan && plan !== source) throw new Error("直接提交文档时不需要另填方案");
    plan = source;
  }
  if (!plan || !/\/(docx|wiki)\//.test(plan)) throw new Error("请指定 docx 或 wiki 方案");
  const doc = (await read(["docs", "+fetch", "--doc", plan, "--doc-format", "markdown"])).document;
  if (!doc?.document_id || typeof doc.content !== "string" || !doc.content.trim())
    throw new Error("方案正文为空或读取不完整");
  return {
    source,
    ...(guid && { taskGuid: guid, taskTitle: task?.summary, taskDescription: task?.description }),
    planUrl: plan,
    planDocumentId: doc.document_id,
    planRevision: doc.revision_id,
    planMarkdown: doc.content,
  };
}
