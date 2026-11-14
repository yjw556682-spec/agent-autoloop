// A bot must not read documents or queue work from other groups, other senders, or unmentioned messages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readSubmission } from "../examples/recipes/personal-multimachine/feishu.ts";

const identity = { group: "oc_group", owner: "ou_owner", bot: "ou_bot" };
const message = {
  chat_id: identity.group,
  chat_type: "group",
  sender_id: identity.owner,
  sender_type: "user",
  message_type: "text",
  message_id: "om_first",
  mentions: [{ id: identity.bot, key: "@_user_1" }],
  content: "@_user_1 总结 https://example.feishu.cn/docx/Plan",
};
test("only an explicit task from the configured owner and group is read", async () => {
  for (const change of [
    { chat_id: "other" },
    { sender_id: "other" },
    { sender_type: "app" },
    { mentions: [] },
    { chat_type: "p2p" },
  ])
    assert.equal(
      await readSubmission({ ...message, ...change }, identity, async () => assert.fail("read outside submission")),
      null,
    );
  const read: string[] = [];
  const task = await readSubmission(message, identity, async (url) => {
    read.push(url);
    return { document_id: "Plan", revision_id: 2, content: "方案原文" };
  });
  assert.deepEqual(read, ["https://example.feishu.cn/docx/Plan"]);
  assert.equal(task?.id, "feishu:om_first");
  assert.match(Buffer.from(task!.files[0].data, "base64").toString(), /方案原文/);
  assert.match(Buffer.from(task!.files[0].data, "base64").toString(), /版本：2/);
});
