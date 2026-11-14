import { agentId, agentNames, baseUrl, label } from "./data.ts";
import type { DeviceRecord, Upstream } from "./server.ts";
import type { GatewayConfig } from "./gateway.ts";
import type { Feishu } from "./feishu.ts";

export type ServiceConfig = {
  directory: string;
  port?: number;
  hub: string;
  sourceKey: string;
  owner: string;
  devices: DeviceRecord[];
  gateway?: GatewayConfig;
  allowLoopback?: boolean;
  channel?: { id: string; owner: string };
  feishu?: Feishu;
};

export function personalRules(devices: Pick<DeviceRecord, "name" | "agents">[], channel?: ServiceConfig["channel"]) {
  if (channel && !label.test(channel.id)) throw new Error("通知通道编号无效");
  const routes = devices.flatMap((device) =>
    device.agents.map((agent) => ({
      id: agentId(device.name, agent.id),
      node: device.name,
      name: device.name + " · " + agentNames[agent.use] + " · " + agent.id,
      use: agent.use,
    })),
  );
  return {
    timezone: "Asia/Shanghai",
    sources: { personal: { name: "个人任务" } },
    channels: channel ? { [channel.id]: { name: "本人私聊", answerers: [channel.owner] } } : {},
    agents: Object.fromEntries(
      routes.map(({ id, node, name, use }) => [
        id,
        { name, worker: node, use, access: use === "zcode" ? "read" : "edit", timeout: 30 },
      ]),
    ),
    rules: routes.map(({ id }) => ({
      name: id,
      when: { source: "personal", types: [id] },
      to: id,
      cwd: "~/",
      prompt: "在本轮工作区内处理个人任务，保存成果。需要本人决定时提交卡片。",
      group: id,
      parallel: 1,
      tell: "needed",
      ...(channel && { channels: [channel.id] }),
    })),
  };
}

export function connectHub(config: ServiceConfig): Upstream {
  const origin = baseUrl(config.hub, true);
  if (!config.sourceKey || config.sourceKey === config.owner) throw new Error("来源与本人密钥必须独立");
  return async (method, path, key, body) => {
    const response = await fetch(origin + path, {
      method,
      redirect: "error",
      headers: {
        authorization: "Bearer " + (path === "/v1/events" ? config.sourceKey : key),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(path.startsWith("/v1/work?") ? 85_000 : 15_000),
    });
    return { status: response.status, body: await response.json() };
  };
}
