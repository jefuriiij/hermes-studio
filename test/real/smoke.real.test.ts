// Opt-in smoke test against the REAL installed Hermes (HERMES_STUDIO_REAL=1,
// Windows only; skipped otherwise). Zero quota: Hermes runs in a sandboxed
// home whose only model is a fake server on 127.0.0.1, and the test aborts
// before any prompt unless session/new confirms that (see harness.ts).
//
// Deliberately independent of src/host: a minimal inline JSON-RPC driver
// spawns hermes.exe acp and checks the facts the extension is built on — one
// shared messageId for a reply's reasoning and answer, end_turn, a title that
// arrives after the response, and a clean exit on stdin EOF with no process
// left behind.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  alivePids,
  assertFakeProvider,
  assertNoForeignEnv,
  createHermesSandbox,
  DEFAULT_CONTENT,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_REASONING,
  DEFAULT_TITLE,
  descendantPids,
  FIXTURE_MODEL,
  type FakeModel,
  type HermesSandbox,
  killTree,
  RUN_REAL,
  startFakeModel,
} from "./harness";

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface RpcMessage {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
}

interface SessionUpdate {
  sessionUpdate: string;
  messageId?: string;
  content?: { type?: string; text?: string };
  title?: string;
  used?: number;
  size?: number;
}

interface UpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };

const PROMPT = "Reply with a short greeting; do not use tools.";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Just enough newline-delimited JSON-RPC 2.0 to drive one Hermes session. */
class MiniRpc {
  readonly updates: UpdateParams[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (m: RpcMessage) => void>();
  private readonly waiters = new Set<() => void>();
  private buffer = "";
  private nextId = 1;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const reply = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, (m) => {
        if (m.error) reject(new Error(`${method} failed: ${JSON.stringify(m.error)}`));
        else resolve(m.result);
      });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return withTimeout(reply, timeoutMs, method).finally(() => this.pending.delete(id));
  }

  /** Resolve with the first update (already received or future) matching `pred`. */
  async waitForUpdate(pred: (p: UpdateParams) => boolean, timeoutMs: number, what: string) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.updates.find(pred);
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${what}: not seen within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, left);
        this.waiters.add(wake);
      });
    }
  }

  private send(msg: unknown): void {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onMessage(JSON.parse(line) as RpcMessage);
      nl = this.buffer.indexOf("\n");
    }
  }

  private onMessage(msg: RpcMessage): void {
    if (msg.method === "session/update") {
      this.updates.push(msg.params as UpdateParams);
      for (const wake of [...this.waiters]) wake();
    } else if (msg.method !== undefined && msg.id !== undefined) {
      // A request from Hermes (ids start at 0). Tools are disabled, so none is
      // expected; deny a permission request, refuse anything else.
      if (msg.method === "session/request_permission") {
        this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
      } else {
        this.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
    } else if (typeof msg.id === "number") {
      this.pending.get(msg.id)?.(msg);
    }
  }
}

describe.skipIf(!RUN_REAL)("real Hermes, zero quota (fake model on 127.0.0.1)", () => {
  let fake: FakeModel | undefined;
  let sandbox: HermesSandbox | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<Exit> | undefined;
  let stderr = "";

  beforeAll(async () => {
    fake = await startFakeModel();
    sandbox = createHermesSandbox({
      fakeModel: fake,
      parentDir: process.env.HERMES_STUDIO_REAL_TMPDIR || undefined,
    });
    console.log(`[real] sandbox ${sandbox.root}; fake model ${fake.baseUrl}`);
  });

  afterAll(async () => {
    try {
      // A failed test can leave Hermes running; its tree must die before the
      // sandbox (which it holds files in) can be removed.
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        killTree(child.pid);
        if (exited) await withTimeout(exited, 10_000, "exit after taskkill").catch(() => {});
      }
    } finally {
      await fake?.close();
      sandbox?.dispose();
    }
  });

  it("initialize → session/new → one prompt → clean exit, no leftover processes", async () => {
    const sb = sandbox as HermesSandbox;
    const model = fake as FakeModel;
    const proc = spawn(sb.command, sb.args, {
      cwd: sb.cwd,
      env: sb.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;
    exited = new Promise<Exit>((resolve) => {
      proc.on("exit", (code, signal) => resolve({ code, signal }));
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d: string) => {
      stderr += d;
    });
    const rpc = new MiniRpc(proc);

    try {
      const init = await rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "hermes-studio-real-test", version: "0" },
        },
        60_000,
      );
      expect(init).toMatchObject({ protocolVersion: 1, agentInfo: { name: "hermes-agent" } });

      const opened = await rpc.request("session/new", { cwd: sb.cwd, mcpServers: [] }, 90_000);
      // SAFETY ABORT: nothing below runs unless the session is on the fake.
      assertFakeProvider(opened);
      assertNoForeignEnv(stderr, sb.hermesHome);
      const sessionId = (opened as { sessionId: string }).sessionId;
      // Building the session probes /models but must not call the model.
      expect(model.requests.filter((r) => r.method === "POST")).toEqual([]);
      await rpc.waitForUpdate(
        (p) => p.sessionId === sessionId && p.update.sessionUpdate === "usage_update",
        10_000,
        "usage_update after session/new",
      );
      // While Hermes runs: afterwards Windows no longer links the children to it.
      const tree = descendantPids(proc.pid as number);

      const mark = rpc.updates.length;
      const result = await rpc.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: PROMPT }] },
        120_000,
      );
      expect(result).toMatchObject({ stopReason: "end_turn" });

      const turn = rpc.updates
        .slice(mark)
        .filter((p) => p.sessionId === sessionId)
        .map((p) => p.update);
      const thoughts = turn.filter((u) => u.sessionUpdate === "agent_thought_chunk");
      const messages = turn.filter((u) => u.sessionUpdate === "agent_message_chunk");
      const text = (us: SessionUpdate[]) => us.map((u) => u.content?.text ?? "").join("");
      expect(text(thoughts)).toBe(DEFAULT_REASONING.join(""));
      expect(text(messages)).toBe(DEFAULT_CONTENT.join(""));
      // The fact the reducer's per-kind ids exist for: reasoning and answer
      // share ONE messageId.
      const ids = new Set([...thoughts, ...messages].map((u) => u.messageId));
      expect(ids.size).toBe(1);
      expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(turn.lastIndexOf(thoughts.at(-1) as SessionUpdate)).toBeLessThan(
        turn.indexOf(messages[0] as SessionUpdate),
      );
      const usage = turn.filter((u) => u.sessionUpdate === "usage_update").at(-1);
      expect(usage?.size).toBe(DEFAULT_CONTEXT_LENGTH);
      expect(usage?.used).toBeGreaterThan(0);

      const posts = model.requests.filter((r) => r.method === "POST");
      expect(posts[0]?.body).toMatchObject({ model: FIXTURE_MODEL, stream: true });

      // Hermes's auto-title call runs after the turn: its update lands after
      // the response.
      await rpc.waitForUpdate(
        (p) =>
          p.sessionId === sessionId &&
          p.update.sessionUpdate === "session_info_update" &&
          p.update.title === DEFAULT_TITLE,
        15_000,
        "late session_info_update title",
      );
      // Hermes wrote its state into the sandbox, not the real home.
      expect(fs.existsSync(path.join(sb.hermesHome, "state.db"))).toBe(true);

      proc.stdin.end();
      const exit = await withTimeout(exited, 10_000, "exit after stdin EOF");
      expect(exit).toEqual({ code: 0, signal: null });
      await sleep(1500);
      expect(alivePids(tree)).toEqual([]);
      console.log(`[real] ok: descendants while running ${JSON.stringify(tree)}, none left`);
    } catch (err) {
      console.error(
        `[real] Hermes stderr (last 40 lines):\n${stderr.split("\n").slice(-40).join("\n")}`,
      );
      throw err;
    }
  }, 240_000);
});
