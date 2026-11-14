// A real hub must fan out once, accept each role's bounded events, join once, and resume the review question.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { teamRules } from "../examples/recipes/bootcamp-team/rules.ts";
import { setup } from "./helpers.ts";

const home = setup("bootcamp-pipeline");
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
const team = teamRules({
  home,
  workspace: home,
  recipe: home,
  node: process.execPath,
  worker: "w",
  channels: ["desktop"],
  knowledgeRoot: home,
  deliveryGuide: join(home, "guide.md"),
});
writeFileSync(
  process.env.AGENT_AUTOLOOP_RULES,
  JSON.stringify({
    timezone: "Asia/Shanghai",
    sources: { local: { name: "本机" } },
    channels: { desktop: { name: "测试通知" } },
    ...team,
  }),
);
const { ingest, claimNext, finish, answer, getView } = await import("./hub.ts");
const { rows } = await import("../kernel/evolve.ts");

test("the complete role chain uses upstream receipts and retains the human review stop", () => {
  const subject = "bootcamp-0123456789abcdef01234567";
  const event = (id: string, type: string) => ({ id: `${subject}:${id}`, type, subject });
  const accepted = ingest("local", event("input", "bootcamp.pipeline.requested"));
  assert.deepEqual(accepted.routed, ["实训营·资料统筹"]);
  const planner = claimNext("w", "planner")!;
  assert.equal(planner.agent.id, "bootcamp-planner");
  assert.deepEqual(
    finish(planner.run, planner.token, {
      outcome: "done",
      summary: "facts fixture",
      events: [event("facts", "bootcamp.materials.requested")],
    }).rejected,
    [],
  );
  const producers = [claimNext("w", "ppt")!, claimNext("w", "ta")!, claimNext("w", "poster")!];
  assert.deepEqual(producers.map((job) => job.agent.id).sort(), ["bootcamp-poster", "bootcamp-ppt", "bootcamp-ta"]);
  for (const producer of producers) {
    const role = producer.agent.id.replace("bootcamp-", "");
    assert.deepEqual(
      finish(producer.run, producer.token, {
        outcome: "done",
        summary: "artifact fixture",
        events: [event(role, `bootcamp.${role}.ready`)],
      }).rejected,
      [],
    );
  }
  const gate = claimNext("w", "gate")!;
  assert.equal(gate.agent.id, "bootcamp-gate");
  const result = {
    outcome: "done",
    summary: "three artifact fixtures ready",
    events: [event("review", "bootcamp.review.requested")],
  };
  assert.deepEqual(finish(gate.run, gate.token, result).rejected, []);
  finish(gate.run, gate.token, result);
  const review = claimNext("w", "review")!;
  assert.equal(review.agent.id, "bootcamp-review");
  finish(review.run, review.token, {
    outcome: "done",
    summary: "待本人审核",
    ask: [
      { key: "draft-review", title: "审核草稿", text: "三份草稿待审核", options: ["修改", "暂存"], about: subject },
    ],
  });
  const cards = rows(getView(), "cards");
  assert.equal(cards.length, 1);
  answer(Number(cards[0].id), { choice: 0 });
  const continued = claimNext("w", "continued")!;
  assert.equal(continued.agent.id, "bootcamp-review");
  assert.equal(continued.context.answers.length, 1);
  assert.equal(rows(getView(), "events").filter((item) => item.type === "bootcamp.review.requested").length, 1);
});
