import { collect, reader } from "../../examples/recipes/bootcamp-team/collect.ts";
import { canonicalLink } from "../../examples/recipes/bootcamp-team/core.ts";
import { label } from "../../examples/recipes/personal-multimachine/data.ts";
import { IntakeError } from "./intake.ts";

export function createPersonalIntake(read?: ReturnType<typeof reader>, targets?: string[]) {
  return async (input: unknown) => {
    const value = input as Record<string, unknown> | null;
    if (
      !value ||
      typeof value.id !== "string" ||
      !/^[\w-]{1,100}$/.test(value.id) ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      value.text.length > 12000 ||
      typeof value.node !== "string" ||
      !label.test(value.node) ||
      typeof value.agent !== "string" ||
      !label.test(value.agent) ||
      typeof value.review !== "boolean" ||
      typeof value.link !== "string" ||
      (value.plan !== undefined && typeof value.plan !== "string")
    ) {
      throw new IntakeError(400, "请填写任务要求并选择执行电脑与 Agent。");
    }
    if (targets && !targets.includes(value.node + "/" + value.agent))
      throw new IntakeError(409, "这个入口尚未配置所选执行器。");
    const knowledge = value.knowledge === undefined ? [] : value.knowledge;
    if (
      !Array.isArray(knowledge) ||
      knowledge.length > 32 ||
      knowledge.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) ||
      new Set(knowledge).size !== knowledge.length
    )
      throw new IntakeError(400, "请选择有效的共享资料版本。");
    let link = "",
      plan = "";
    try {
      if (value.link.trim()) link = canonicalLink(value.link.trim());
      if (typeof value.plan === "string" && value.plan.trim()) plan = canonicalLink(value.plan.trim());
      if (plan && !link) throw new Error();
    } catch {
      throw new IntakeError(400, "请填写有效的飞书任务或 docx、wiki 文档链接。");
    }
    const files: { name: string; data: string }[] = [];
    if (link) {
      if (!read) throw new IntakeError(409, "此入口尚未连接本机飞书，请通过本机启动器打开工作台。");
      let snapshot;
      try {
        snapshot = await collect({ link, plan: plan || undefined }, read);
      } catch (error) {
        throw new IntakeError(403, (error as Error).message);
      }
      files.push({
        name: "飞书资料.md",
        data: Buffer.from(
          [
            `来源：${snapshot.source}`,
            `方案：${snapshot.planUrl}`,
            `文档：${snapshot.planDocumentId}`,
            `版本：${snapshot.planRevision ?? "未返回"}`,
            "",
            ...(snapshot.taskTitle
              ? ["任务标题：" + snapshot.taskTitle, "任务描述：" + (snapshot.taskDescription ?? ""), ""]
              : []),
            snapshot.planMarkdown,
          ].join("\n"),
        ).toString("base64"),
      });
    }
    return {
      id: "workbench-" + value.id,
      node: value.node,
      agent: value.agent,
      text:
        value.text.trim() +
        (value.review
          ? "\n\n先保存草稿到 output/，通过回执 ask 请本人审核。收到审核意见后，读取 previous/ 中的上一轮成果再修改；审核前不要发布或发送。"
          : ""),
      files,
      knowledge,
    };
  };
}

export const personalIntake = (program?: string, targets?: string[]) =>
  createPersonalIntake(program ? reader(program) : undefined, targets);
