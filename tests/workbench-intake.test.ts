import assert from "node:assert/strict";
import { test } from "node:test";
import { createBootcampIntake } from "../scripts/workbench/intake.ts";

test("structured paused and unchanged receipts remain truthful in the browser", async () => {
  for (const status of ["paused", "unchanged", "queued", "baseline"]) {
    const message = `状态：${status}`;
    const intake = createBootcampIntake(async () => JSON.stringify({ autoloopIntake: 1, status, message }));
    assert.deepEqual(await intake({ link: "https://a.feishu.cn/docx/a" }), { message });
  }
  const bad = createBootcampIntake(async () =>
    JSON.stringify({ autoloopIntake: 1, status: "unknown", message: "成功" }),
  );
  await assert.rejects(bad({ link: "https://a.feishu.cn/docx/a" }));
});

test("concurrent identical intake requests read Feishu and emit once", async () => {
  let calls = 0;
  let done!: (value: string) => void;
  const intake = createBootcampIntake(async () => {
    calls++;
    return new Promise((resolve) => {
      done = resolve;
    });
  });
  const input = { link: "https://example.feishu.cn/docx/abc" };
  const one = intake(input);
  const two = intake(input);
  done("交给了：实训营草稿\n草稿目录：本地");
  assert.deepEqual(await one, await two);
  assert.equal(calls, 1);
});

test("invalid links never reach the executor; failed runs can be retried", async () => {
  let calls = 0;
  const intake = createBootcampIntake(async () => {
    calls++;
    throw new Error("private token in stderr");
  });
  for (const input of [
    null,
    { link: "https://example.feishu.cn.evil.com/docx/x" },
    { link: "https://u:p@a.feishu.cn/docx/x" },
    { link: "https://a.feishu.cn/docx/x", plan: false },
  ]) {
    await assert.rejects(intake(input), /有效.*飞书/);
  }
  assert.equal(calls, 0);
  const input = { link: "https://a.feishu.cn/docx/x" };
  await assert.rejects(
    intake(input),
    (error: Error) => !error.message.includes("private") && /未确认/.test(error.message),
  );
  await assert.rejects(intake(input));
  assert.equal(calls, 2);
});

test("unrouted output is a conflict, not a successful submission", async () => {
  const intake = createBootcampIntake(async () => "记下了，还没有规则接它。");
  await assert.rejects(
    intake({ link: "https://a.feishu.cn/docx/x" }),
    (error: Error & { status: number }) => error.status === 409,
  );
});

test("a burst of distinct submissions is bounded without starting another queue", async () => {
  let calls = 0;
  const finish: ((value: string) => void)[] = [];
  const intake = createBootcampIntake(async () => {
    calls++;
    return new Promise((resolve) => finish.push(resolve));
  });
  const first = intake({ link: "https://a.feishu.cn/docx/one" });
  const second = intake({ link: "https://a.feishu.cn/docx/two" });
  await assert.rejects(
    intake({ link: "https://a.feishu.cn/docx/three" }),
    (error: Error & { status: number }) => error.status === 429,
  );
  assert.equal(calls, 2);
  finish.forEach((done) => done("交给了：草稿"));
  await Promise.all([first, second]);
});
