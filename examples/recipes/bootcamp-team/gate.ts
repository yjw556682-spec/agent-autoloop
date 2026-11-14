// Producers acknowledge final bytes; a later worker must not see half-written drafts as ready.
import { readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { hash } from "./core.ts";
import { outputs } from "./rules.ts";
import { output, settings } from "./runtime.ts";

export async function ready(root: string, caseId: string) {
  if (!/^bootcamp-[a-f0-9]{24}$/.test(caseId)) throw new Error("案例编号无效");
  const folder = join(root, "cases", caseId);
  for (const [role, filename] of Object.entries(outputs)) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(folder, `${role}.ready.json`), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (manifest.caseId !== caseId || manifest.file !== filename || !/^[a-f0-9]{64}$/.test(manifest.sha256))
      throw new Error("就绪记录与案例或产物不一致");
    const path = await realpath(join(folder, "drafts", filename));
    const rel = relative(await realpath(join(folder, "drafts")), path);
    if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("产物不在本案例草稿目录");
    const file = await readFile(path);
    if (hash(file) !== manifest.sha256) throw new Error("产物在就绪后发生变化，需要制作者重新检查");
    const valid =
      role === "poster"
        ? file.length > 45 &&
          file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
          file.subarray(12, 16).toString() === "IHDR" &&
          file.subarray(-8, -4).toString() === "IEND"
        : file.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) &&
          file.includes(Buffer.from("[Content_Types].xml")) &&
          file.includes(Buffer.from(role === "ppt" ? "ppt/presentation.xml" : "word/document.xml")) &&
          file.includes(Buffer.from([80, 75, 5, 6]));
    if (!valid) throw new Error("产物文件格式不正确，不能进入汇总检查");
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = await settings(process.argv[2]);
  const context = JSON.parse(await readFile(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
  const subjects = [...new Set<string>(context.events.map((event: { subject: string }) => event.subject))];
  const events = [];
  for (const subject of subjects)
    if (await ready(config.workspace, subject))
      events.push({
        id: `${subject}:review`,
        type: "bootcamp.review.requested",
        subject,
        summary: "三份草稿已通过交接检查",
        detail: "进入内容与视觉检查，仍需本人审核",
      });
  output(events.length ? "三份草稿已齐，交给汇总检查。" : "没事可做：等待其余角色提交就绪事件。", { events });
}
