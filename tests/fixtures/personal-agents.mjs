// A local executable lets the test inspect what reaches the actual Agent process.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const request = readFileSync("request.txt", "utf8");
assert.equal(process.argv[2], request.split(" ")[0]);
const use = process.argv[3];
assert.equal(process.env.AGENT_AUTOLOOP_HOME, undefined);
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.AUTOLOOP_MODEL_KEY, undefined);
if (use === "codex") {
  assert.ok(process.argv.includes("--ephemeral"));
} else if (use === "claude") {
  assert.ok(process.argv.includes("--restricted"));
  assert.ok(process.argv.includes("--no-session-persistence"));
  assert.ok(process.argv.includes("claude-fixture"));
  assert.match(process.env.ANTHROPIC_AUTH_TOKEN, /^fixture-lease-[12]$/);
  assert.equal(process.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:1");
} else {
  assert.equal(use, "zcode");
  assert.ok(process.argv.includes("plan"));
  assert.ok(process.argv.includes("--json"));
  assert.equal(process.env.HOME, process.env.ZCODE_DATA_BASE_DIR);
  const { config } = JSON.parse(readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8"));
  assert.equal(config.defaultModelSelection.modelId, "zcode-fixture");
  const [{ config: provider }] = config.providerConfigRules.providerRules;
  assert.equal(provider.api.baseUrl, "http://127.0.0.1:1/v1");
  assert.match(provider.access.apiKey, /^fixture-lease-[12]$/);
}
await new Promise((resolve) => setTimeout(resolve, 1800));
const context = JSON.parse(readFileSync("context.json", "utf8"));
let summary = "成果已写入";
if (request.includes("审核") && !context.answers.length) {
  writeFileSync("output/checkpoint.md", "等待本人确认");
  summary +=
    "\n```agent-autoloop\n" +
    JSON.stringify({
      ask: [
        {
          key: "review",
          title: "检查草稿",
          text: "是否接着做？",
          options: ["继续", "暂存"],
          about: "从已有检查点继续",
        },
      ],
    }) +
    "\n```";
} else {
  if (request.includes("审核")) assert.equal(readFileSync("previous/checkpoint.md", "utf8"), "等待本人确认");
  const draft = readFileSync("input/notes.md", "utf8") + " · " + request;
  if (use === "zcode") summary = draft;
  else writeFileSync("output/draft.md", draft);
}
if (use === "claude") {
  console.log(JSON.stringify({ type: "result", subtype: "success", result: summary, session_id: "temporary-claude" }));
} else if (use === "zcode") {
  console.log(JSON.stringify({ response: summary, sessionId: "temporary-zcode", usage: { inputTokens: 10 } }));
} else {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "temporary-test-session" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: summary } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } }));
}
