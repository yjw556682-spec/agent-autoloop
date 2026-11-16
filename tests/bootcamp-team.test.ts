// Guard the opt-in source boundary, delivery checkpoint and role handoff before enabling the recipe.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalLink,
  fingerprint,
  hash,
  receiveSnapshot,
  registry,
  watchRegistered,
  type Snapshot,
} from "../examples/recipes/bootcamp-team/core.ts";
import { teamRules } from "../examples/recipes/bootcamp-team/rules.ts";
import { collect } from "../examples/recipes/bootcamp-team/collect.ts";
import { ready } from "../examples/recipes/bootcamp-team/gate.ts";

const original: Snapshot = {
  source: "https://example.feishu.cn/docx/abc",
  planUrl: "https://example.feishu.cn/docx/abc",
  planDocumentId: "abc",
  planRevision: 1,
  planMarkdown: "本场方案",
};
async function workspace(t: { after(fn: () => Promise<void>): void }) {
  const folder = await mkdtemp(join(tmpdir(), "autoloop-team-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test("only a valid Feishu task or document becomes a registered source", () => {
  assert.equal(canonicalLink(original.source + "?x=1#part"), original.source);
  assert.throws(() => canonicalLink("https://feishu.cn.evil.test/docx/a"));
  assert.throws(() => canonicalLink("https://example.feishu.cn/wiki/../../config.json"));
  assert.throws(() => canonicalLink("https://u:p@example.feishu.cn/docx/a"));
  assert.throws(() => canonicalLink("https://example.feishu.cn/base/a"));
  assert.equal(fingerprint(original), fingerprint({ ...original, planRevision: 99 }));
  assert.notEqual(fingerprint(original), fingerprint({ ...original, planMarkdown: "新内容" }));
});

test("first registration baselines without triggering agents; only registered content changes emit", async (t) => {
  const root = await workspace(t);
  const events: string[] = [];
  const emit = async (event: { id: string }) => {
    events.push(event.id);
    return { event: 1, routed: ["实训营·资料统筹"], paused: [] };
  };
  await receiveSnapshot(root, original, emit, "baseline");
  assert.equal(events.length, 0);
  const visited: string[] = [];
  await watchRegistered(
    root,
    async (target) => {
      visited.push(target.link);
      return original;
    },
    emit,
  );
  assert.deepEqual(visited, [original.source]);
  assert.equal(events.length, 0);
  await watchRegistered(root, async () => ({ ...original, planMarkdown: "修订后的排期" }), emit);
  assert.equal(events.length, 1);
  await watchRegistered(root, async () => ({ ...original, planMarkdown: "修订后的排期" }), emit);
  assert.equal(events.length, 1);
});

test("an uncertain delivery keeps the old checkpoint and retries the same event ID", async (t) => {
  const root = await workspace(t);
  await receiveSnapshot(
    root,
    original,
    async () => {
      throw new Error("should not emit");
    },
    "baseline",
  );
  const changed = { ...original, planUrl: "https://example.feishu.cn/docx/new", planMarkdown: "变更" };
  let first = "";
  await assert.rejects(
    receiveSnapshot(root, changed, async (event) => {
      first = event.id;
      throw new Error("lost response");
    }),
  );
  assert.equal(Object.values((await registry(root)).targets)[0].fingerprint, fingerprint(original));
  assert.equal(Object.values((await registry(root)).targets)[0].plan, changed.planUrl);
  await receiveSnapshot(root, changed, async (event) => {
    assert.equal(event.id, first);
    return { event: 2, routed: ["实训营·资料统筹"], paused: [] };
  });
  assert.equal(Object.values((await registry(root)).targets)[0].fingerprint, fingerprint(changed));
});

test("overlapping manual intake and watcher commits do not lose registrations or emit twice", async (t) => {
  const root = await workspace(t);
  let calls = 0;
  const emit = async () => {
    calls++;
    return { event: calls, routed: ["实训营·资料统筹"], paused: [] };
  };
  const other = {
    ...original,
    source: "https://example.feishu.cn/docx/xyz",
    planUrl: "https://example.feishu.cn/docx/xyz",
    planDocumentId: "xyz",
  };
  await Promise.all([
    receiveSnapshot(root, original, emit),
    receiveSnapshot(root, original, emit),
    receiveSnapshot(root, other, emit),
  ]);
  assert.equal(calls, 2);
  assert.equal(Object.keys((await registry(root)).targets).length, 2);
});

test("a paused rule records its event once and does not claim an agent has started", async (t) => {
  const root = await workspace(t);
  const result = await receiveSnapshot(root, original, async () => ({
    event: 1,
    routed: [],
    paused: ["实训营·资料统筹"],
  }));
  assert.equal(result.status, "paused");
  assert.match(result.message, /暂停/);
});

test("a confirmed unrouted event can be submitted after rules are restored; uncertain delivery keeps its ID", async (t) => {
  const root = await workspace(t);
  let missed = "";
  await assert.rejects(
    receiveSnapshot(root, original, async (event) => {
      missed = event.id;
      return { event: 1, routed: [], paused: [] };
    }),
  );
  let retry = "";
  await assert.rejects(
    receiveSnapshot(root, original, async (event) => {
      retry = event.id;
      assert.notEqual(retry, missed);
      throw new Error("uncertain response");
    }),
  );
  await receiveSnapshot(root, original, async (event) => {
    assert.equal(event.id, retry);
    return { event: 2, routed: ["实训营·资料统筹"] };
  });
});

test("roles fan out from shared facts and converge through the artifact gate", () => {
  const result = teamRules({
    home: "D:/example",
    workspace: "D:/example/bootcamp",
    recipe: "D:/repo/examples/recipes/bootcamp-team",
    node: "node",
    worker: "local",
    channels: ["desktop"],
    knowledgeRoot: "D:/notes",
    deliveryGuide: "D:/skills/delivery.md",
  });
  const materialRules = result.rules.filter(
    (rule) => "source" in rule.when && rule.when.types.includes("bootcamp.materials.requested"),
  );
  assert.equal(materialRules.length, 3);
  assert.equal(new Set(materialRules.map((rule) => rule.to)).size, 3);
  assert.equal(
    result.rules.filter((rule) => "source" in rule.when && rule.when.types.includes("bootcamp.review.requested"))
      .length,
    1,
  );
  assert.ok(result.rules.every((rule) => rule.tell !== "always"));
  assert.ok(Object.values(result.agents).every((agent) => agent.use === "command" || agent.access === "edit"));
});

test("the collector reads only the submitted task and selected plan; ambiguity never guesses", async () => {
  const guid = "12345678-1234-1234-1234-123456789abc";
  const link = `https://example.feishu.cn/client/todo/task?guid=${guid}`;
  const calls: string[][] = [];
  const read = async (args: string[]) => {
    calls.push(args);
    return args[0] === "task"
      ? { task: { guid, description: `${original.source} https://example.feishu.cn/docx/other` } }
      : { document: { document_id: "abc", revision_id: 1, content: "方案" } };
  };
  await assert.rejects(collect({ link }, read), /唯一/);
  assert.equal(calls.length, 1);
  calls.length = 0;
  const snapshot = await collect({ link, plan: original.source }, read);
  assert.equal(snapshot.taskGuid, guid);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["task", "tasks", "get", "--task-guid", guid]);
  assert.ok(calls[1].includes(original.source));
  await assert.rejects(
    collect({ link: original.source }, async () => ({ document: {} })),
    /不完整/,
  );
});

test("unreadable registered sources retain their checkpoint and do not block other registered sources", async (t) => {
  const root = await workspace(t);
  const other = { ...original, source: "https://example.feishu.cn/docx/xyz" };
  const emit = async () => ({ event: 1, routed: ["实训营·资料统筹"] });
  await receiveSnapshot(root, original, emit, "baseline");
  await receiveSnapshot(root, other, emit, "baseline");
  const result = await watchRegistered(
    root,
    async (target) => {
      if (target.link === original.source) throw new Error("private auth failure");
      return { ...other, planMarkdown: "已变更" };
    },
    emit,
  );
  assert.deepEqual(result.errors, [original.source]);
  assert.equal(result.results[0].status, "queued");
  assert.equal((await registry(root)).targets[hash(original.source)].fingerprint, fingerprint(original));
});

test("the join waits for every role and rejects a replaced final artifact", async (t) => {
  const root = await workspace(t);
  const id = "bootcamp-0123456789abcdef01234567";
  const folder = join(root, "cases", id);
  await mkdir(join(folder, "drafts"), { recursive: true });
  assert.equal(await ready(root, id), false);
  // Structural fixtures exercise the handoff contract, not Office rendering or design quality.
  const zip = (entry: string) =>
    Buffer.concat([
      Buffer.from([80, 75, 3, 4]),
      Buffer.from(`[Content_Types].xml ${entry}`),
      Buffer.from([80, 75, 5, 6]),
    ]);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nEkAAAAASUVORK5CYII=",
    "base64",
  );
  for (const [role, filename, bytes] of [
    ["ppt", "课程草稿.pptx", zip("ppt/presentation.xml")],
    ["ta", "助教培训草稿.docx", zip("word/document.xml")],
    ["poster", "海报草稿.png", png],
  ] as const) {
    await writeFile(join(folder, "drafts", filename), bytes);
    await writeFile(
      join(folder, `${role}.ready.json`),
      JSON.stringify({ caseId: id, file: filename, sha256: hash(bytes) }),
    );
  }
  assert.equal(await ready(root, id), true);
  await writeFile(join(folder, "drafts", "海报草稿.png"), "incomplete new version");
  await assert.rejects(ready(root, id), /发生变化/);
  await assert.rejects(ready(root, "../../config"), /无效/);
});
