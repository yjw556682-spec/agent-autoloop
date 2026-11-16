import { randomUUID } from "node:crypto";
import { baseUrl, Problem } from "./data.ts";
import type { Gateway } from "./server.ts";

export type ModelProtocol = "chat" | "messages" | "responses";
export type GatewayModel = {
  id: string;
  label: string;
  provider: string;
  group: string;
  protocols: ModelProtocol[];
  billing?: "metered" | "subscription";
};
export type ModelProbe = {
  model: string;
  protocol: ModelProtocol;
  ok: boolean;
  checkedAt: string;
  ms: number;
  tokens: number;
  text: string;
  error?: string;
};
export type GatewayStatus = {
  connected: boolean;
  checkedAt: string;
  defaultModel: string;
  budget: number;
  durationMinutes: number;
  models: (GatewayModel & { available: boolean })[];
  usage: {
    days: number;
    requests: number;
    failed: number;
    tokens: number;
    usd: number;
    models: { model: string; requests: number; tokens: number; usd: number }[];
  } | null;
};

export type GatewayConfig = {
  url: string;
  key: string;
  publicBase: string;
  model: string;
  budget: number;
  models?: GatewayModel[];
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
  const models = config.models ?? [
    { id: config.model, label: config.model, provider: "已配置供应商", group: "默认", protocols: ["chat" as const] },
  ];
  if (
    !models.length ||
    new Set(models.map((x) => x.id)).size !== models.length ||
    !models.some((x) => x.id === config.model) ||
    models.some(
      (x) =>
        !/^[\w][\w./:-]{0,127}$/.test(x.id) ||
        !x.label ||
        !x.provider ||
        !x.group ||
        !x.protocols.length ||
        x.protocols.some((p) => !["chat", "messages", "responses"].includes(p)),
    )
  )
    throw new Error("模型目录无效");
  async function request(path: string, body?: object, credential = config.key, timeout = 15_000) {
    const response = await fetch(url + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: {
        authorization: "Bearer " + credential,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`模型网关未确认（HTTP ${response.status}）`);
    return response.json();
  }
  let probing = false;
  const gateway: Gateway = {
    models,
    defaultModel: config.model,
    async issue(name, model = config.model) {
      if (!models.some((x) => x.id === model)) throw new Problem(409, "此模型尚未接入网关");
      const issued = await request("/key/generate", {
        key_alias: name,
        models: [model],
        duration: "35m",
        max_budget: config.budget,
        max_parallel_requests: 1,
        ...(models.find((m) => m.id === model)?.billing === "subscription" && { rpm_limit: 10, tpm_limit: 120000 }),
        metadata: { autoloop_run: name },
      });
      if (typeof issued.key !== "string" || !issued.key) throw new Error("模型网关没有返回有效凭据");
      return { key: issued.key, model, base: config.publicBase };
    },
    async revoke(key) {
      await request("/key/delete", { keys: [key] });
    },
    async status() {
      const now = new Date();
      const start = new Date(now.getTime() - 6 * 86400_000).toISOString().slice(0, 10);
      const end = new Date(now.getTime() + 86400_000).toISOString().slice(0, 10);
      const [catalog, spend] = await Promise.allSettled([
        request("/v1/models"),
        request(`/spend/logs?start_date=${start}&end_date=${end}&summarize=false`),
      ]);
      const available =
        catalog.status === "fulfilled" && Array.isArray(catalog.value?.data)
          ? catalog.value.data.map((x: any) => x.id)
          : [];
      let usage: GatewayStatus["usage"] = null;
      if (spend.status === "fulfilled" && Array.isArray(spend.value)) {
        const rows = new Map<string, { model: string; requests: number; tokens: number; usd: number }>();
        usage = { days: 7, requests: 0, failed: 0, tokens: 0, usd: 0, models: [] };
        const positive = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
        for (const log of spend.value) {
          const model =
            typeof log.model_group === "string" && log.model_group
              ? log.model_group
              : typeof log.model === "string"
                ? log.model
                : "未标明";
          const row = rows.get(model) ?? { model, requests: 0, tokens: 0, usd: 0 };
          row.requests++;
          row.tokens += positive(log.total_tokens);
          row.usd += positive(log.spend);
          rows.set(model, row);
          usage.requests++;
          usage.failed += log.status === "failure" ? 1 : 0;
          usage.tokens += positive(log.total_tokens);
          usage.usd += positive(log.spend);
        }
        usage.models = [...rows.values()];
      }
      return {
        connected: catalog.status === "fulfilled",
        checkedAt: now.toISOString(),
        defaultModel: config.model,
        budget: config.budget,
        durationMinutes: 35,
        models: models.map((m) => ({ ...m, available: available.includes(m.id) })),
        usage,
      };
    },
    async probe(model, protocol, prompt) {
      if (!models.some((x) => x.id === model && x.protocols.includes(protocol)))
        throw new Problem(409, "模型没有配置这个接口");
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000)
        throw new Problem(400, "试调用内容需要在 1–4000 字以内");
      if (probing) throw new Problem(409, "已有试调用正在进行，请等待结果");
      probing = true;
      let key: string | undefined;
      const began = Date.now();
      const result: ModelProbe = {
        model,
        protocol,
        ok: false,
        checkedAt: new Date().toISOString(),
        ms: 0,
        tokens: 0,
        text: "",
      };
      try {
        key = (await gateway.issue("autoloop-probe-" + randomUUID(), model)).key;
        const payload =
          protocol === "responses"
            ? { model, input: prompt, max_output_tokens: 512 }
            : { model, messages: [{ role: "user", content: prompt }], max_tokens: 512 };
        const data = await request(
          protocol === "chat" ? "/v1/chat/completions" : "/v1/" + protocol,
          payload,
          key,
          45_000,
        );
        const text =
          protocol === "chat"
            ? data.choices?.[0]?.message?.content
            : protocol === "messages"
              ? data.content
                  ?.filter((b: any) => b.type === "text")
                  .map((b: any) => b.text)
                  .join("\n")
              : data.output
                  ?.flatMap((b: any) => b.content ?? [])
                  .filter((b: any) => b.type === "output_text")
                  .map((b: any) => b.text)
                  .join("\n");
        result.text = typeof text === "string" ? text.slice(0, 8000) : "";
        result.tokens =
          Number(data.usage?.total_tokens ?? (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)) || 0;
        result.ok = Boolean(result.text.trim());
        if (!result.ok) result.error = "接口已返回，但没有取得完整文本；可能达到本次输出上限。";
      } catch (error) {
        const status = /HTTP (\d+)/.exec(String(error))?.[1];
        result.error = status
          ? `调用未通过（HTTP ${status}），请检查模型权限、额度和接口配置。`
          : "调用未完成，请检查连接或稍后重试。";
      } finally {
        try {
          if (key) await gateway.revoke(key);
        } catch {
          throw new Problem(503, "试调用结束，但临时凭据撤销未确认；请检查网关，凭据仍受原到期限制。");
        } finally {
          probing = false;
        }
      }
      result.ms = Date.now() - began;
      return result;
    },
  };
  return gateway;
}
