import { baseUrl } from "./data.ts";
import type { Gateway } from "./server.ts";

export type GatewayConfig = {
  url: string;
  key: string;
  publicBase: string;
  model: string;
  budget: number;
};

export function liteLLM(config: GatewayConfig, allowLoopback = false): Gateway {
  const url = baseUrl(config.url, true);
  const client = new URL(config.publicBase);
  if (
    config.publicBase !== baseUrl(client.origin, allowLoopback) + "/v1" ||
    !config.key ||
    !config.model ||
    !Number.isFinite(config.budget) ||
    config.budget <= 0
  )
    throw new Error("模型网关需要有效地址、模型与本轮额度");
  async function post(path: string, body: object) {
    const response = await fetch(url + path, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: "Bearer " + config.key, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`模型网关未确认（HTTP ${response.status}）`);
    return response.json();
  }
  return {
    async issue(name, model = config.model) {
      const issued = await post("/key/generate", {
        key_alias: name,
        models: [model],
        duration: "35m",
        max_budget: config.budget,
        max_parallel_requests: 1,
        metadata: { autoloop_run: name },
      });
      if (typeof issued.key !== "string" || !issued.key) throw new Error("模型网关没有返回有效凭据");
      return { key: issued.key, model, base: config.publicBase };
    },
    async revoke(key) {
      await post("/key/delete", { keys: [key] });
    },
  };
}
