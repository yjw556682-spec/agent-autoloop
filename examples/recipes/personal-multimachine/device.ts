import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { agentId, files, baseUrl, maxBytes, Problem, safeName, type Profile, type Run, taskName } from "./data.ts";
import type { Result } from "../../../protocol/validate.ts";
import type { Lease } from "./server.ts";

export type LocalAgent = Profile & {
  program: string;
  args?: string[];
  codexHome?: string;
  isolatedHost?: boolean;
};
export type Device = {
  name: string;
  url: string;
  key: string;
  agents: LocalAgent[];
  capacity?: number;
  allowLoopback?: boolean;
};

export async function call(
  device: Device,
  path: string,
  options: { token?: string; body?: unknown; timeout?: number } = {},
) {
  const response = await fetch(baseUrl(device.url, device.allowLoopback) + path, {
    redirect: "error",
    headers: {
      authorization: "Bearer " + device.key,
      ...(options.token ? { "x-run-token": options.token } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { method: "POST", body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeout ?? 90_000),
  });
  if (!response.ok) throw new Problem(response.status, `服务器未确认（HTTP ${response.status}）`);
  return response.json();
}

const runPath = (job: Pick<Run, "run" | "attempt">, part: string) => `/personal/runs/${job.run}/${job.attempt}/${part}`;

export async function prepareRun(device: Device, job: Run, dir: string) {
  const input = await call(device, runPath(job, "input"), { token: job.token });
  const profile = device.agents.find((agent) => agent.id === input.agent);
  if (
    !taskName.test(input.id) ||
    !profile ||
    profile.mode !== input.mode ||
    profile.use !== job.agent.use ||
    job.agent.id !== agentId(device.name, profile.id)
  )
    throw new Error("任务与本机执行方式不一致");
  if (profile.use === "zcode" && (!profile.isolatedHost || profile.mode !== "api"))
    throw new Error("ZCode 需要隔离执行环境和统一 API");
  const cwd = join(dir, "workspace");
  const incoming = join(cwd, "input");
  const output = join(cwd, "output");
  const scratch = join(dir, "temp");
  for (const folder of [incoming, output, scratch]) await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(cwd, "request.txt"), input.text, { mode: 0o600 });
  await writeFile(join(cwd, "context.json"), JSON.stringify(job.context), { mode: 0o600 });
  const previous = files(input.previous ?? []);
  if (previous.length) {
    const folder = join(cwd, "previous");
    await mkdir(folder, { mode: 0o700, recursive: true });
    for (const file of previous)
      await writeFile(join(folder, file.name), Buffer.from(file.data, "base64"), { mode: 0o600 });
  }
  for (const file of files(input.files))
    await writeFile(join(incoming, file.name), Buffer.from(file.data, "base64"), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_\w+|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(
        name,
      )
    )
      env[name] = value;
  }
  Object.assign(env, { TMP: scratch, TEMP: scratch, TMPDIR: scratch, XDG_CACHE_HOME: scratch, NO_COLOR: "1" });
  let lease: Lease | undefined;
  if (profile.mode === "api") {
    const issued: Lease = await call(device, runPath(job, "lease"), { token: job.token, body: {} });
    const endpoint = new URL(issued.base);
    if (
      issued.base !== baseUrl(endpoint.origin, device.allowLoopback) + "/v1" ||
      !issued.key ||
      !issued.model ||
      (profile.model && issued.model !== profile.model)
    )
      throw new Error("模型网关凭据无效");
    lease = issued;
  }
  const args =
    profile.use === "claude"
      ? claudeArgs(profile, env, scratch, lease)
      : profile.use === "zcode"
        ? await zcodeArgs(env, scratch, lease!)
        : await codexArgs(profile, env, dir, lease);
  const command = /\.(cjs|mjs|js)$/i.test(profile.program) ? [process.execPath, profile.program] : [profile.program];
  return { cwd, env, argv: [...command, ...(profile.args ?? []), ...args] };
}

async function codexArgs(profile: LocalAgent, env: NodeJS.ProcessEnv, dir: string, lease?: Lease) {
  const scratch = join(dir, "temp");
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    'web_search="disabled"',
    "-c",
    'shell_environment_policy.exclude=["AUTOLOOP_MODEL_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY"]',
  ];
  args.push(
    "-c",
    `sqlite_home=${JSON.stringify(join(scratch, "state"))}`,
    "-c",
    `log_dir=${JSON.stringify(join(scratch, "logs"))}`,
  );
  if (process.platform === "win32") args.push("-c", 'windows.sandbox="elevated"');
  if (lease) {
    env.CODEX_HOME = join(dir, "codex");
    await mkdir(env.CODEX_HOME, { mode: 0o700, recursive: true });
    env.AUTOLOOP_MODEL_KEY = lease.key;
    args.push(
      "-m",
      lease.model,
      "-c",
      'model_provider="personal_gateway"',
      "-c",
      `model_providers.personal_gateway.base_url=${JSON.stringify(lease.base)}`,
      "-c",
      'model_providers.personal_gateway.name="Autoloop"',
      "-c",
      'model_providers.personal_gateway.env_key="AUTOLOOP_MODEL_KEY"',
      "-c",
      'model_providers.personal_gateway.wire_api="responses"',
      "-c",
      "model_providers.personal_gateway.supports_websockets=false",
    );
  } else {
    if (profile.model) args.push("-m", profile.model);
    if (profile.codexHome) {
      if (!isAbsolute(profile.codexHome)) throw new Error("Codex 登录目录必须是绝对路径");
      env.CODEX_HOME = profile.codexHome;
    }
  }
  return [...args, "--"];
}

function claudeArgs(profile: LocalAgent, env: NodeJS.ProcessEnv, scratch: string, lease?: Lease) {
  const model = lease?.model ?? profile.model;
  if (lease)
    Object.assign(env, {
      CLAUDE_CONFIG_DIR: join(scratch, "claude"),
      ANTHROPIC_BASE_URL: new URL(lease.base).origin,
      ANTHROPIC_AUTH_TOKEN: lease.key,
    });
  Object.assign(env, { DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-mode",
    "acceptEdits",
    "--tools",
    "Read,Write,Edit,Glob,Grep",
    ...(model ? ["--model", model] : []),
    "--",
  ];
}

async function zcodeArgs(env: NodeJS.ProcessEnv, scratch: string, lease: Lease) {
  const home = join(scratch, "zcode");
  const config = join(home, ".zcode", "cli");
  const provider = join(home, "provider.json");
  await mkdir(config, { recursive: true, mode: 0o700 });
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({
      features: { mcp: false, subagent: false, memory: false, skill: false },
      memory: { use: false },
      plugins: { enabled: false },
      skills: { enabled: false },
      hooks: { enabled: false },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    provider,
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "autoloop",
              providerName: "Autoloop",
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: lease.key },
                api: { type: "openai-chat-completions", baseUrl: lease.base },
                personalModelIds: [lease.model],
              },
            },
          ],
        },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: { providerId: "autoloop", modelId: lease.model },
      },
    }),
    { mode: 0o600 },
  );
  for (const name of Object.keys(env))
    if (/^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA)$/i.test(name)) delete env[name];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    ZCODE_DATA_BASE_DIR: home,
    ZCODE_STORAGE_DIR: join(home, "storage"),
    ZCODE_LOG_DIR: join(home, "logs"),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: provider,
  });
  return [
    "--mode",
    "plan",
    "--no-color",
    "--json",
    "--workflow-mode",
    "disabled",
    "--disallowed-tools",
    "Bash WebFetch WebSearch Agent Task AskUserQuestion EnterPlanMode ExitPlanMode",
    "--prompt",
  ];
}

export async function captureAnswer(job: Run, dir: string, text: string) {
  if (job.agent.use !== "zcode") return;
  const answer = text.replace(/```agent-autoloop[ \t]*\r?\n[\s\S]*?```/g, "").trim();
  if (answer) await writeFile(join(dir, "response.md"), answer + "\n", { mode: 0o600 });
}

export async function finishRun(device: Device, job: Run, dir: string, result: Result) {
  const output = join(dir, "workspace", "output");
  const location = await realpath(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (location) {
    const within = relative(await realpath(dir), location);
    if (within !== "workspace" + sep + "output") throw new Error("成果目录不在本轮工作区");
  }
  const entries = await readdir(output, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let bytes = 0;
  const uploaded = [];
  if (entries.length > 32) throw new Error("一次最多回传 32 份成果");
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = safeName(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("成果目录仅接受普通文件");
    const path = join(output, name);
    if (!(await lstat(path)).isFile()) throw new Error("成果必须是普通文件");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.nlink > 1) throw new Error("成果必须是本轮生成的普通文件");
      if (bytes + file.size > maxBytes) throw new Error("成果超过 24 MB");
      const content = await handle.readFile();
      bytes += content.length;
      if (bytes > maxBytes) throw new Error("成果超过 24 MB");
      uploaded.push({ name, data: content.toString("base64") });
    } finally {
      await handle.close();
    }
  }
  if (job.agent.use === "zcode" && !uploaded.length && result.outcome === "done") {
    const answer = await open(join(dir, "response.md"), "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (answer) {
      try {
        if ((await answer.stat()).size > maxBytes) throw new Error("成果超过 24 MB");
        uploaded.push({ name: "response.md", data: (await answer.readFile()).toString("base64") });
      } finally {
        await answer.close();
      }
    }
  }
  const { outcome, summary, error, usage, ask } = result;
  const receipt = { outcome, summary, error, usage, ask };
  try {
    return await call(device, runPath(job, "complete"), {
      token: job.token,
      body: { files: uploaded, result: receipt },
    });
  } catch (error) {
    if (error instanceof Problem && error.status === 410) return { rejected: [{ reason: "这一轮已失效" }] };
    throw error;
  }
}

export function reportCleanup(device: Device, job: Pick<Run, "run" | "attempt" | "token">) {
  return call(device, runPath(job, "cleaned"), { token: job.token, body: {} });
}
