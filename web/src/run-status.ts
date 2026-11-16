import type { RunView } from "./hub";
const states: Record<RunView["state"], string> = {
  queued: "排队",
  claimed: "运行中",
  unknown: "待核查",
  done: "已完成",
  nothing: "无需处理",
  cancelled: "已停止",
};
export const runStatus = (run: RunView) =>
  run.stopping ? "正在停止" : run.state === "queued" && run.attempts > 0 ? "等重试" : (states[run.state] ?? run.state);
