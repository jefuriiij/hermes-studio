// Helpers for the OPT-IN real-Hermes tests in test/real (HERMES_STUDIO_REAL=1,
// Windows only). They drive the installed hermes.exe, and they are built so a
// run can never reach a real model or touch the user's real Hermes state:
//
//   - The only model Hermes is configured with is startFakeModel(): an
//     OpenAI-compatible server on 127.0.0.1, as provider "custom".
//   - HERMES_HOME, USERPROFILE and HOME point into a temp dir, and every env var
//     that could carry a credential or a Hermes override is dropped.
//   - assertFakeProvider() is the abort before any prompt: unless session/new
//     reports custom:fixture-model, the test stops before sending one.
//
// The recipe was verified end to end against Hermes 0.21.5 (plan §11.3). What
// is load-bearing and not obvious:
//   - hermes.exe activates its Python dependencies from <HERMES_HOME>\installs
//     whenever HERMES_HOME lies outside %LOCALAPPDATA%\hermes. A temp home has
//     none, so Hermes tries to "complete a source update" by downloading
//     CPython, and dies. A JUNCTION <temp>\home\.hermes\installs →
//     %LOCALAPPDATA%\hermes\installs, plus HERMES_RUNTIME_DIR and
//     HERMES_DISABLE_LAZY_INSTALLS=1, makes it use the installed environment.
//   - That junction points at the real Hermes venv, and a recursive delete that
//     follows it wipes the venv. dispose() therefore unlinks it, proves it is
//     gone, and only then deletes; if it cannot, it deletes nothing and throws.
//   - Python's Path.home() reads USERPROFILE on Windows, not HOME, so both are
//     overridden; otherwise ~/.claude and ~/.codex credentials stay visible.
//   - The junction means a run takes the same runtime locks in the real
//     installs dir as any Hermes launch: don't run it during `hermes update`.
//
// Env: HERMES_STUDIO_REAL=1 enables the suite. HERMES_STUDIO_REAL_TMPDIR, if
// set, is where the sandbox temp dir is created (default: os.tmpdir()).

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const IS_WINDOWS = process.platform === "win32";
export const REAL_ENABLED = process.env.HERMES_STUDIO_REAL === "1";
/** Opted in AND on Windows. Elsewhere the suite is skipped, not failed: the
 *  recipe (junction, %LOCALAPPDATA% layout, hermes.exe, PowerShell process
 *  checks) only exists on Windows. */
export const RUN_REAL = REAL_ENABLED && IS_WINDOWS;

export const FIXTURE_MODEL = "fixture-model";
/** What session/new must report before any prompt is allowed. */
export const FIXTURE_MODEL_ID = `custom:${FIXTURE_MODEL}`;
const FIXTURE_API_KEY = "local-fixture-key";

// The verified fake's reply: markdown, a code fence and a <script> tag, the
// same text as test/fixtures/hermes-wire/turn-reasoning-reply.json.
export const DEFAULT_REASONING: readonly string[] = [
  "Thinking about ",
  "how to greet ",
  "the user.",
];
export const DEFAULT_CONTENT: readonly string[] = [
  "# Hello\n\n",
  "Here is **bold** text and ",
  "a list:\n\n- one\n- two\n\n",
  "```ts\nconst x = 1;\n```\n\n",
  "<script>alert(1)</script> done.",
];
export const DEFAULT_TITLE = "Fixture Title";
/** Hermes reports it back as usage_update.size. */
export const DEFAULT_CONTEXT_LENGTH = 128_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible model server

export interface FakeModelOptions {
  /** Streamed as delta.reasoning_content, one chunk each (Hermes → agent_thought_chunk). */
  reasoning?: readonly string[];
  /** Streamed as delta.content, one chunk each (Hermes → agent_message_chunk). */
  content?: readonly string[];
  /** Delay between streamed chunks; raise it for cancel tests. Default 40 ms, as verified. */
  chunkDelayMs?: number;
  /** Reply to non-streaming completions, which is how Hermes asks for a session title. */
  title?: string;
  contextLength?: number;
  log?: (line: string) => void;
}

export interface FakeModelRequest {
  at: number;
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON, or the raw text if it was not JSON. */
  body: unknown;
  /** The client hung up before the reply finished (e.g. Hermes interrupted the turn). */
  aborted: boolean;
}

export interface FakeModel {
  port: number;
  /** http://127.0.0.1:<port>/v1 — what goes into config.yaml. */
  baseUrl: string;
  /** Every request received, in order. */
  requests: FakeModelRequest[];
  close(): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Start the fake model on 127.0.0.1 (loopback only, random port). Streaming
 * chat completions get chat.completion.chunk frames: reasoning deltas, content
 * deltas, a finish chunk, a usage-only chunk with `choices: []` (Hermes sets
 * stream_options.include_usage), then `data: [DONE]`. Non-streaming ones get
 * the title. GET /v1/models, /v1/models/:id and /api/v1/models (Hermes probes
 * all three) describe one model whose context_length becomes Hermes's context
 * window.
 */
export function startFakeModel(opts: FakeModelOptions = {}): Promise<FakeModel> {
  const reasoning = opts.reasoning ?? DEFAULT_REASONING;
  const content = opts.content ?? DEFAULT_CONTENT;
  const chunkDelayMs = opts.chunkDelayMs ?? 40;
  const title = opts.title ?? DEFAULT_TITLE;
  const contextLength = opts.contextLength ?? DEFAULT_CONTEXT_LENGTH;
  const log = opts.log ?? (() => {});
  const requests: FakeModelRequest[] = [];
  const model = {
    id: FIXTURE_MODEL,
    object: "model",
    created: 1,
    owned_by: "fixture",
    context_length: contextLength,
  };

  const sendJson = (res: http.ServerResponse, status: number, value: unknown) => {
    const data = JSON.stringify(value);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    });
    res.end(data);
  };

  async function stream(res: http.ServerResponse, entry: FakeModelRequest): Promise<void> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const base = {
      id: `fixture-${requests.length}`,
      object: "chat.completion.chunk",
      created: 1,
      model: FIXTURE_MODEL,
    };
    const send = (frame: unknown) => {
      if (!entry.aborted && !res.destroyed) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    let first = true;
    const delta = (fields: Record<string, unknown>) => {
      const d = first ? { role: "assistant", ...fields } : fields;
      first = false;
      return { ...base, choices: [{ index: 0, delta: d, finish_reason: null }] };
    };
    for (const r of reasoning) {
      if (entry.aborted) return;
      send(delta({ content: null, reasoning_content: r }));
      await sleep(chunkDelayMs);
    }
    for (const c of content) {
      if (entry.aborted) return;
      send(delta({ content: c }));
      await sleep(chunkDelayMs);
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    send({
      ...base,
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });
    if (!entry.aborted && !res.destroyed) res.end("data: [DONE]\n\n");
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) raw += chunk;
    let body: unknown = raw;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        // keep the raw text
      }
    }
    const entry: FakeModelRequest = {
      at: Date.now(),
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body,
      aborted: false,
    };
    requests.push(entry);
    res.on("close", () => {
      if (!res.writableFinished) entry.aborted = true;
    });
    const isStream = isRecord(body) && body.stream === true;
    log(`[fake-model] ${entry.method} ${entry.url}${isRecord(body) ? ` stream=${isStream}` : ""}`);

    const pathname = new URL(entry.url, "http://127.0.0.1").pathname.replace(/\/+$/, "");
    if (entry.method === "GET") {
      if (/\/models\/[^/]+$/.test(pathname)) return sendJson(res, 200, model);
      // /v1/models, /api/v1/models — and, as in the verified fake, any other
      // GET probe gets the list rather than a 404 that could change Hermes's path.
      return sendJson(res, 200, { object: "list", data: [model] });
    }
    if (entry.method !== "POST" || !pathname.endsWith("/chat/completions") || !isRecord(body)) {
      return sendJson(res, 404, { error: { message: `fake model: no route ${entry.url}` } });
    }
    if (isStream) return stream(res, entry);
    sendJson(res, 200, {
      id: `fixture-${requests.length}`,
      object: "chat.completion",
      created: 1,
      model: FIXTURE_MODEL,
      choices: [
        { index: 0, message: { role: "assistant", content: title }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`[fake-model] handler error: ${String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(err) } });
      else res.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            // Hermes keeps HTTP connections alive; close() alone would wait on them.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Isolated Hermes home

export interface SandboxOptions {
  fakeModel: Pick<FakeModel, "baseUrl">;
  /** Where the temp dir is created. Default: os.tmpdir(). */
  parentDir?: string;
}

export interface HermesSandbox {
  /** Absolute path to the installed hermes.exe. */
  command: string;
  args: string[];
  /** The workspace folder: spawn cwd and session/new cwd. */
  cwd: string;
  /** The complete child environment (not a patch over process.env). */
  env: Record<string, string>;
  /** The temp dir that holds everything below. */
  root: string;
  hermesHome: string;
  /** Delete the sandbox. Unlinks the installs junction first and verifies it
   *  is gone; if it cannot, leaves the temp dir in place and throws.
   *  Idempotent. Call only after Hermes has exited. */
  dispose(): void;
}

// Same drop list as the verified driver: anything that could carry a real
// credential, and every HERMES_* override (the shell may set HERMES_HOME).
const DROP_CREDENTIALS =
  /(API_KEY|TOKEN|SECRET|PASSWORD|^OPENAI|^ANTHROPIC|^OPENROUTER|^NOUS|^GEMINI|^GOOGLE|^XAI|^AZURE|^AWS|^HERMES_|^CLAUDE|^CODEX)/i;
// The editor host's own variables (plan §4): with ELECTRON_RUN_AS_NODE set, an
// Electron app the agent launches would run as plain Node.
const DROP_EDITOR_HOST = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|VSCODE_.*)$/i;

/** Set a key, first removing any other casing of it: a Windows env block
 *  with both HOME and Home is ambiguous about which one the child sees. */
function setEnv(env: Record<string, string>, key: string, value: string): void {
  for (const k of Object.keys(env)) if (k.toLowerCase() === key.toLowerCase()) delete env[k];
  env[key] = value;
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Every symlink or junction under `dir`, without descending into any of
 *  them. Node reports a Windows junction as a symbolic link, never as a
 *  directory (checked on this machine), so the walk cannot cross one. */
function findLinks(dir: string): string[] {
  const links: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) links.push(full);
      else if (entry.isDirectory()) stack.push(full);
    }
  }
  return links;
}

/**
 * Create an isolated Hermes home wired to `fakeModel`: temp dir, config.yaml
 * (provider custom → the fake, no MCP servers, memory off, one iteration, all
 * toolsets disabled), the installs junction, and a scrubbed environment.
 */
export function createHermesSandbox(opts: SandboxOptions): HermesSandbox {
  if (!IS_WINDOWS) {
    throw new Error("createHermesSandbox is Windows-only (junction + %LOCALAPPDATA% layout)");
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is not set");
  const realRoot = path.join(localAppData, "hermes");
  const command = path.join(realRoot, "bin", "hermes.exe");
  const realInstalls = path.join(realRoot, "installs");
  if (!fs.statSync(command, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`hermes.exe not found at ${command}`);
  }
  if (!fs.statSync(realInstalls, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Hermes installs dir not found at ${realInstalls}`);
  }
  const baseUrl = opts.fakeModel.baseUrl;
  if (new URL(baseUrl).hostname !== "127.0.0.1") {
    throw new Error(`refusing a model endpoint that is not on 127.0.0.1: ${baseUrl}`);
  }

  const root = fs.mkdtempSync(path.join(opts.parentDir ?? os.tmpdir(), "hermes-studio-real-"));
  const home = path.join(root, "home");
  const hermesHome = path.join(home, ".hermes");
  const cwd = path.join(root, "work");
  const junction = path.join(hermesHome, "installs");

  const unlink = (link: string) => {
    if (!lexists(link)) return;
    try {
      fs.unlinkSync(link);
    } catch (err) {
      throw new Error(
        `could not unlink ${link} (${String(err)}). Left ${root} in place: remove the link ` +
          "itself (rmdir, never a recursive delete) before deleting the folder.",
      );
    }
    if (lexists(link)) {
      throw new Error(`${link} still exists after unlink. Left ${root} in place; do not rm -r it.`);
    }
  };

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    // 1. The junction into the real venv — first, and proven gone.
    unlink(junction);
    // 2. Any other link that appeared under root, then prove none is left.
    for (const link of findLinks(root)) unlink(link);
    const left = findLinks(root);
    if (left.length > 0) {
      throw new Error(`refusing to delete ${root}: links remain: ${left.join(", ")}`);
    }
    // 3. Only now a recursive delete. Retries ride out Windows holding
    //    state.db for a moment after Hermes exits.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    disposed = true;
  };

  try {
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.symlinkSync(realInstalls, junction, "junction");

    const config = [
      "model:",
      "  provider: custom",
      `  default: ${FIXTURE_MODEL}`,
      `  base_url: ${baseUrl}`,
      `  api_key: ${FIXTURE_API_KEY}`,
      "  api_mode: chat_completions",
      "mcp_servers: {}",
      "memory:",
      "  memory_enabled: false",
      "  user_profile_enabled: false",
      "agent:",
      "  max_iterations: 1",
      "  disabled_toolsets: [all]",
      "",
    ].join("\n");
    const configPath = path.join(hermesHome, "config.yaml");
    fs.writeFileSync(configPath, config);
    // Pre-flight: what Hermes will read really points at the fake.
    const back = fs.readFileSync(configPath, "utf8");
    if (!back.includes(`base_url: ${baseUrl}`) || !back.includes("provider: custom")) {
      throw new Error("ABORT: config.yaml does not point at the fake model");
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || DROP_CREDENTIALS.test(key) || DROP_EDITOR_HOST.test(key)) continue;
      env[key] = value;
    }
    setEnv(env, "HERMES_HOME", hermesHome);
    setEnv(env, "HERMES_RUNTIME_DIR", path.join(realRoot, "tools"));
    setEnv(env, "HERMES_DISABLE_LAZY_INSTALLS", "1");
    setEnv(env, "HERMES_ACP_SKIP_CONFIGURED_MCP", "1");
    setEnv(env, "OPENAI_API_KEY", FIXTURE_API_KEY);
    setEnv(env, "OPENAI_BASE_URL", baseUrl);
    setEnv(env, "USERPROFILE", home);
    setEnv(env, "HOME", home);

    return { command, args: ["acp"], cwd, env, root, hermesHome, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Safety checks

/**
 * The abort before any prompt: throws unless session/new bound the session to
 * the fake model. Anything else (the user's real provider leaking in through
 * config or env) could spend real quota.
 */
export function assertFakeProvider(sessionNewResult: unknown): void {
  const models = isRecord(sessionNewResult) ? sessionNewResult.models : undefined;
  const current = isRecord(models) ? models.currentModelId : undefined;
  if (current !== FIXTURE_MODEL_ID) {
    throw new Error(
      `ABORT before any prompt: session/new reports currentModelId ${JSON.stringify(current)}, ` +
        `not ${FIXTURE_MODEL_ID}. Refusing to prompt a model that may not be the local fake.`,
    );
  }
}

/** Throws if Hermes's stderr shows it loaded a .env from outside the sandbox
 *  (it logs "Loaded env from <path>", or "No .env found at <path>"). */
export function assertNoForeignEnv(stderr: string, hermesHome: string): void {
  const inside = path.resolve(hermesHome).toLowerCase();
  for (const match of stderr.matchAll(/Loaded env from (.+?)\s*$/gm)) {
    const loaded = path.resolve(match[1] as string).toLowerCase();
    const rel = path.relative(inside, loaded);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`ABORT before any prompt: Hermes loaded ${match[1]}, outside the sandbox`);
    }
  }
}

// ---------------------------------------------------------------------------
// Windows process checks

interface ProcessRow {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
}

function processTable(): ProcessRow[] {
  const script =
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | " +
    "ConvertTo-Json -Compress";
  // No try/catch on purpose: a failed query must fail the test, not read as
  // "no processes left".
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    },
  ).trim();
  const parsed: unknown = out ? JSON.parse(out) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]) as ProcessRow[];
}

/** Every process below `rootPid` right now (not including it). Take this
 *  while Hermes runs: once a parent exits, Windows no longer links children
 *  to it. The distlib launcher's job uses silent breakaway, so these are the
 *  processes that can outlive hermes.exe. */
export function descendantPids(rootPid: number): number[] {
  if (!IS_WINDOWS) return [];
  const children = new Map<number, number[]>();
  for (const row of processTable()) {
    const list = children.get(row.ParentProcessId) ?? [];
    list.push(row.ProcessId);
    children.set(row.ParentProcessId, list);
  }
  const found: number[] = [];
  // A recycled parent pid can make the table cyclic; `seen` keeps the walk finite.
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** The subset of `pids` still running. Read from the full process table:
 *  `Get-Process -Id a,b -ErrorAction SilentlyContinue` exits 1 when any id is
 *  gone, and a caller that catches that reads it as "none alive". */
export function alivePids(pids: readonly number[]): number[] {
  if (!IS_WINDOWS || pids.length === 0) return [];
  const running = new Set(processTable().map((row) => row.ProcessId));
  return pids.filter((pid) => running.has(pid));
}

/** Kill a process and its whole tree (the launcher does not take its children
 *  down). Best effort: an already-gone pid is not an error. */
export function killTree(pid: number): void {
  if (!IS_WINDOWS) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
    return;
  }
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // exit 128: no such process — already gone
  }
}
