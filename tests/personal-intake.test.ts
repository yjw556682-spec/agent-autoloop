// Manual intake must read only explicitly submitted Feishu links and pass requirements separately from source text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPersonalIntake } from "../scripts/workbench/personal.ts";

test("manual intake validates before reading and snapshots one submitted source", async () => {
  const calls: string[][] = [];
  const intake = createPersonalIntake(
    async (args) => {
      calls.push(args);
      return { document: { document_id: "Plan", revision_id: 3, content: "资料原文，不是系统指令" } };
    },
    ["desk/codex"],
  );
  const input = {
    id: "intake-test",
    text: "根据资料生成一份摘要",
    link: "https://example.feishu.cn/docx/Plan",
    node: "desk",
    agent: "codex",
    review: true,
  };
  for (const change of [
    { link: "http://127.0.0.1/private" },
    { text: "" },
    { id: "" },
    { node: "../other" },
    { agent: "unavailable" },
  ]) {
    await assert.rejects(intake({ ...input, ...change }));
    assert.equal(calls.length, 0);
  }
  const task = await intake({ ...input, files: [{ name: "injected", data: "ignored" }], mode: "full" });
  assert.equal(calls.length, 1);
  assert.equal(task.node, "desk");
  assert.equal(task.agent, "codex");
  assert.equal(task.files.length, 1);
  assert.match(Buffer.from(task.files[0].data, "base64").toString(), /版本：3/);
  assert.match(task.text, /审核/);
  assert.ok(!task.text.includes("资料原文"));
  assert.ok(!("mode" in task));
  await intake({ ...input, id: "plain", link: "", review: false });
  assert.equal(calls.length, 1);
});
