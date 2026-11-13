import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { bootcampIntake, IntakeError } from "./workbench/intake.ts";

const DIST = join(import.meta.dirname, "..", "web", "dist");
const HOST = "127.0.0.1";
const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const RUN = /^\/v1\/runs\/[1-9]\d*\/(why|cancel)$/;
const CARD = /^\/v1\/cards\/[1-9]\d*\/(answer|resolve)$/;
const RULE = /^\/v1\/rules\/[^/]+\/(pause|resume|run|replay)$/;

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json") {
  res.writeHead(status, {
    ...HEADERS,
    "content-type": type.startsWith("image/") ? type : type + "; charset=utf-8",
    ...(type.startsWith("image/") && { "cache-control": "public, max-age=31536000, immutable" }),
  });
  res.end(body);
}

function error(res: ServerResponse, status: number, message: string) {
  send(res, status, JSON.stringify({ error: message }));
}

function authorized(request: IncomingMessage, token: string) {
  const expected = Buffer.from("Bearer " + token);
  const received = Buffer.from(request.headers.authorization ?? "");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

type Options = {
  home: string;
  port: number;
  token: string;
  bootcamp?: boolean;
};

export function serveWorkbench({ home, port, token, bootcamp = false }: Options) {
  const intake = bootcamp ? bootcampIntake(home) : undefined;
  async function call(path: string, signal: AbortSignal, body?: string) {
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    const endpoint = new URL(config.url);
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== HOST ||
      endpoint.username ||
      endpoint.password ||
      typeof config.owner !== "string" ||
      !config.owner
    ) {
      throw new Error("Invalid local hub configuration");
    }
    return fetch(endpoint.origin + path, {
      signal,
      redirect: "error",
      headers: {
        authorization: "Bearer " + config.owner,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { method: "POST", body }),
    });
  }

  async function stream(res: ServerResponse, path: string, signal: AbortSignal) {
    // An idle hub flushes only when its next event arrives.
    const ready = await call("/v1/state", AbortSignal.any([signal, AbortSignal.timeout(4000)]));
    await ready.body?.cancel();
    if (!ready.ok) return error(res, 503, "中台暂时连不上。");
    res.writeHead(200, { ...HEADERS, "content-type": "text/event-stream; charset=utf-8" });
    res.write(": connected\n\n");
    const upstream = await call(path, signal);
    if (!upstream.ok || !upstream.body) return res.end();
    const seqOnly = async function* (chunks: AsyncIterable<Uint8Array>) {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of chunks) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const id = /^id: ?(\d+)$/m.exec(frame)?.[1];
          if (id) yield 'data: {"seq":' + id + "}\n\n";
        }
      }
    };
    await pipeline(upstream.body as AsyncIterable<Uint8Array>, seqOnly, res, { signal });
  }

  const server = createServer(async (req, res) => {
    const authority = HOST + ":" + (server.address() as AddressInfo).port;
    const origin = "http://" + authority;
    if (
      req.headers.host !== authority ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      (req.method === "POST" && req.headers.origin !== origin)
    ) {
      return error(res, 403, "请从本机工作台操作。");
    }
    const gone = new AbortController();
    res.once("close", () => gone.abort());
    try {
      const url = new URL(req.url!, origin);
      const path = url.pathname;
      if (req.method === "GET" && path === "/") {
        const page = await readFile(join(DIST, "index.html"), "utf8");
        return send(
          res,
          200,
          page.replace("<script type=", '<script src="/local-session.js"></script><script type='),
          "text/html",
        );
      }
      if (req.method === "GET" && path === "/local-session.js") {
        return send(res, 200, "window.autoloopLocal = " + JSON.stringify({ bootcamp }) + ";", "text/javascript");
      }
      const asset = /^\/assets\/([\w-]+\.(js|css|png))$/.exec(path);
      if (req.method === "GET" && asset) {
        const content = await readFile(join(DIST, "assets", asset[1])).catch(() => null);
        const type = { js: "text/javascript", css: "text/css", png: "image/png" }[asset[2]];
        return content === null ? error(res, 404, "资源不存在。") : send(res, 200, content, type);
      }

      if (req.method === "GET" && path === "/local/session" && authorized(req, token)) {
        return send(res, 200, JSON.stringify({ ok: true, bootcamp }));
      }

      const read =
        (req.method === "GET" && ["/v1/state", "/v1/stream"].includes(path)) ||
        (req.method === "GET" && RUN.exec(path)?.[1] === "why");
      const write =
        req.method === "POST" &&
        (RUN.exec(path)?.[1] === "cancel" ||
          CARD.test(path) ||
          RULE.test(path) ||
          path === "/v1/emit" ||
          (bootcamp && path === "/local/bootcamp"));
      if (!read && !write) return error(res, 404, "没有这个地址。");
      if (!authorized(req, token)) return error(res, 401, "请用启动工作台时显示的会话链接打开。");
      if (path === "/v1/stream") {
        const after = url.searchParams.get("after") ?? "0";
        if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) return error(res, 400, "日志序号不正确。");
        return await stream(res, path + "?after=" + after, gone.signal);
      }

      let body: string | undefined;
      if (write) {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          length += chunk.length;
          if (length > 65_536) {
            res.setHeader("connection", "close");
            return error(res, 413, "提交的内容太长。");
          }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks).toString("utf8") || "{}";
      }
      if (path === "/local/bootcamp" && intake) {
        let input: unknown;
        try {
          input = JSON.parse(body!);
        } catch {
          return error(res, 400, "提交内容格式不正确。");
        }
        try {
          return send(res, 200, JSON.stringify(await intake(input)));
        } catch (failure) {
          if (failure instanceof IntakeError) return error(res, failure.status, failure.message);
          throw failure;
        }
      }
      const upstream = await call(path + url.search, AbortSignal.any([gone.signal, AbortSignal.timeout(6000)]), body);
      if (upstream.status === 401) {
        await upstream.body?.cancel();
        return error(res, 503, "本机工作台无法连接到中台，请检查中台配置。");
      }
      if (upstream.status === 404 && (path === "/v1/emit" || path.endsWith("/replay"))) {
        await upstream.body?.cancel();
        return error(res, 404, path === "/v1/emit" ? "当前中台版本没有网页事件入口。" : "当前中台版本没有补跑接口。");
      }
      send(res, upstream.status, await upstream.text());
    } catch {
      if (res.destroyed) return;
      if (res.headersSent) res.end();
      else error(res, 503, "暂时无法读取中台，稍后再试。");
    }
  });
  return server.listen(port, HOST);
}

if (import.meta.main) {
  const home = process.env.AGENT_AUTOLOOP_HOME || join(homedir(), ".agent-autoloop");
  const port = Number(process.env.AUTOLOOP_WORKBENCH_PORT ?? 3351);
  const token = randomBytes(32).toString("base64url");
  const bootcamp =
    process.platform === "win32" &&
    process.argv.includes("--bootcamp") &&
    (await stat(join(home, "Submit-Bootcamp.ps1")).then(
      (file) => file.isFile(),
      () => false,
    ));
  const server = serveWorkbench({ home, port, token, bootcamp });
  server.on("listening", async () => {
    const address = "http://" + HOST + ":" + (server.address() as AddressInfo).port + "/#/?session=" + token;
    if (process.argv.includes("--session-file")) {
      try {
        await writeFile(join(home, "workbench-session.txt"), address, { mode: 0o600 });
      } catch {
        console.error("无法保存工作台的本机会话。");
        server.close();
        process.exitCode = 1;
      }
    } else console.log(address);
  });
}
