// One Hermes process and its ACP connection. Single-use: a restart creates a
// new HermesClient, so a late event from a dead process can never reach the
// live one (the forked extension's generation bugs, lessons 11-13).
//
// No `vscode` import — the integration tests drive this class directly against
// a fake ACP agent and against the real hermes.exe.
//
// Measured on Hermes 0.21.5 (Windows): initialize answers after ~1.2 s,
// session/new takes ~2.7 s (once 6.8 s), stdout carries only JSON-RPC, ~50 log
// lines go to stderr per start, and stdin EOF makes an idle Hermes exit in
// ~250 ms.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import type { PromptBlock } from "../logic/attachments";
import { sleep, withTimeout } from "../logic/errors";
import { LineBuffer } from "../logic/lines";
import type { PermissionResponse } from "../logic/permissions";

export interface HermesModels {
  availableModels?: { modelId: string; name?: string; description?: string | null }[];
  currentModelId?: string;
}

/** session/new as Hermes answers it: the SDK type lacks `models` (removed from
 *  the protocol in SDK 0.24), but Hermes still sends it and SDK responses are
 *  not validated, so it is there on the raw result. */
export type HermesNewSession = acp.NewSessionResponse & { models?: HermesModels };

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** True when we asked it to stop (shutdown), false for a crash. */
  expected: boolean;
  /** The process never started (ENOENT/EACCES): not a crash. */
  spawnFailed?: boolean;
}

export interface HermesClientOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Our own diagnostic lines. */
  log(line: string): void;
  /** Hermes's stderr, one whole line at a time. */
  onStderrLine(line: string): void;
  /** Log every ACP message (includes prompt text). */
  trace?: boolean;
  /**
   * Every inbound `session/update`, raw and in wire order. Called from the
   * inbound tap BEFORE the SDK validates it, so an update type newer than the
   * SDK still arrives and `_meta` survives. Must not throw or block.
   */
  onSessionUpdate(params: { sessionId: string; update: unknown }): void;
  /** Hermes asks before an edit or a dangerous command. Must always settle. */
  onPermissionRequest(params: acp.RequestPermissionRequest): Promise<PermissionResponse>;
  /** The process is gone (after `exit`). Called once. */
  onExit(info: ExitInfo): void;
  initializeTimeoutMs?: number;
  newSessionTimeoutMs?: number;
  /** Overridable for tests. */
  platform?: string;
}

export interface ShutdownOptions {
  /** A session with a running turn: gets `session/cancel` first. */
  cancelSessionId?: string;
  /** Settles when that turn's session/prompt settles; waited for ≤ 1.5 s. */
  turnSettled?: Promise<unknown>;
}

let nextClientId = 0;

const CLIENT_INFO = { name: "hermes-studio", title: "Hermes Studio", version: "0.1.0" };

// VS Code gives deactivate() 5 s in total before it tears the extension host
// down; the whole shutdown below fits in ~4.2 s.
const CANCEL_WRITE_MS = 500;
const TURN_SETTLE_MS = 1500;
const EOF_EXIT_MS = 2000;
const KILL_EXIT_MS = 700;

export class HermesClient {
  readonly id = ++nextClientId;
  private child?: ChildProcess;
  private conn?: acp.ClientConnection;
  private startPromise?: Promise<acp.InitializeResponse>;
  private stopPromise?: Promise<void>;
  private exitPromise?: Promise<void>;
  private exited = false;
  /** The ACP connection closed (Hermes's stdout ended). This usually comes a
   *  moment BEFORE the process `exit` event; treating the client as dead only
   *  on `exit` let a send in that gap go to a dead connection. */
  private connClosed = false;
  private stopping = false;
  private exitReported = false;
  private markDown: () => void = () => undefined;
  /** Settles once onExit has been reported (exit, or connection loss). */
  readonly down: Promise<void> = new Promise((r) => {
    this.markDown = r;
  });
  initializeResult?: acp.InitializeResponse;

  constructor(private readonly opts: HermesClientOptions) {}

  /** Process running, connected, and not shutting down. */
  get alive(): boolean {
    return this.child !== undefined && !this.exited && !this.connClosed && !this.stopping;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Spawn and handshake. Concurrent callers share one attempt. */
  start(): Promise<acp.InitializeResponse> {
    this.startPromise ??= this.doStart().catch(async (e: unknown) => {
      // A failed handshake leaves nothing behind.
      await this.shutdown().catch(() => undefined);
      throw e;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<acp.InitializeResponse> {
    const o = this.opts;
    this.say(`[ext] starting: "${o.command}" ${o.args.join(" ")}   (cwd: ${o.cwd})`);

    let child: ChildProcess;
    try {
      // shell:false is load-bearing: with a shell in between, closing stdin
      // never reaches Hermes and graceful shutdown silently stops working.
      child = spawn(o.command, [...o.args], {
        cwd: o.cwd,
        env: o.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      // Some spawn failures (EINVAL for a .cmd, EACCES) throw synchronously.
      this.exited = true;
      throw e;
    }
    this.child = child;

    const stderr = new LineBuffer();
    let spawnError: Error | undefined;
    this.exitPromise = new Promise<void>((resolve) => {
      const done = (code: number | null, signal: string | null, spawnFailed = false) => {
        if (this.exited) return resolve();
        this.exited = true;
        try {
          const tail = stderr.flush();
          if (tail !== null) this.stderrLine(tail);
          this.conn?.close(new Error("Hermes exited"));
          this.say(`[ext] hermes exited (code=${code ?? "null"} signal=${signal ?? "none"})`);
        } finally {
          // Whatever happened above, the exit must be reported and awaited
          // shutdowns released — or every later shutdown waits its full timeout.
          this.reportDown({ code, signal, expected: this.stopping, spawnFailed });
          resolve();
        }
      };
      child.once("exit", (code, signal) => done(code, signal));
      child.once("error", (err) => {
        spawnError = err;
        this.say(`[ext] spawn error: ${err.message}`);
        // ENOENT and friends: no process ever existed, so no `exit` follows,
        // and this is not a crash (it must not count toward the crash limit).
        if (child.pid === undefined) done(null, null, true);
      });
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      for (const line of stderr.push(d)) this.stderrLine(line);
    });
    // Writing after Hermes died raises EPIPE on the stream; without a listener
    // that is an unhandled error in the extension host.
    child.stdin?.on("error", (err) => this.say(`[ext] stdin: ${err.message}`));

    if (!child.stdin || !child.stdout) throw new Error("Hermes started without stdio pipes");

    const base = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const tap = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
      transform: (msg, controller) => {
        this.inbound(msg);
        controller.enqueue(msg);
      },
    });
    const stream: acp.Stream = {
      writable: base.writable,
      readable: base.readable.pipeThrough(tap),
    };

    const app = acp
      .client({ name: CLIENT_INFO.name })
      // Dispatched from the tap instead (raw, wire order, nothing dropped); the
      // handler exists so the SDK does not treat the method as unhandled.
      .onNotification("session/update", () => undefined)
      .onRequest("session/request_permission", (ctx) => o.onPermissionRequest(ctx.params));
    this.conn = app.connect(stream);
    void this.conn.closed.then(() => this.onConnectionClosed());

    let init: acp.InitializeResponse;
    try {
      init = await withTimeout(
        this.request("initialize", {
          protocolVersion: acp.PROTOCOL_VERSION,
          // Hermes never calls fs/* or terminal/*; never advertise what we do not implement.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: CLIENT_INFO,
        }),
        o.initializeTimeoutMs ?? 30_000,
        "Hermes (initialize)",
      );
    } catch (e) {
      // A spawn error (ENOENT, EACCES) arrives as an event while initialize is
      // pending and surfaces here as "connection closed"; the spawn error is
      // the one that tells the user what is wrong.
      throw spawnError ?? e;
    }
    this.initializeResult = init;
    this.say(
      `[ext] connected: ${init.agentInfo?.name ?? "agent"} ${init.agentInfo?.version ?? ""} (protocol ${init.protocolVersion})`,
    );
    return init;
  }

  /**
   * Log without ever throwing. VS Code disposes the output channel as soon as
   * deactivate() starts awaiting — before our shutdown finishes — and a
   * disposed channel throws "Channel has been closed". A throwing logger in
   * the shutdown path would skip stdin.end() and the tree-kill.
   */
  private say(line: string): void {
    try {
      this.opts.log(line);
    } catch {
      // the log is gone; the shutdown must go on
    }
  }

  private stderrLine(line: string): void {
    try {
      this.opts.onStderrLine(line);
    } catch {
      // as above
    }
  }

  private reportDown(info: ExitInfo): void {
    if (this.exitReported) return;
    this.exitReported = true;
    try {
      this.opts.onExit(info);
    } finally {
      this.markDown();
    }
  }

  /**
   * Hermes's stdout ended. Normally the process is exiting and `exit` follows
   * within milliseconds — wait briefly for it so onExit carries the real exit
   * code. If the process is still alive after that, it closed its output but
   * kept running: it is useless to us, so report it down and stop it.
   */
  private async onConnectionClosed(): Promise<void> {
    if (this.exited) return;
    this.connClosed = true;
    await Promise.race([this.exitPromise, sleep(1000)]);
    if (this.exited) return;
    this.say("[ext] Hermes closed its output but is still running — stopping it.");
    this.reportDown({ code: null, signal: null, expected: this.stopping });
    const child = this.child;
    if (child && !this.stopping) {
      this.stopping = true;
      await this.killTree(child);
    }
  }

  /** Every inbound message, in wire order, before the SDK processes it. */
  private inbound(msg: acp.AnyMessage): void {
    if (this.opts.trace) this.say(`[acp ←] ${preview(msg)}`);
    const m = msg as { method?: unknown; params?: unknown; id?: unknown };
    if (m.method !== "session/update" || m.id !== undefined) return;
    const p = m.params as { sessionId?: unknown; update?: unknown } | undefined;
    if (!p || typeof p.sessionId !== "string") return;
    try {
      this.opts.onSessionUpdate({ sessionId: p.sessionId, update: p.update });
    } catch (e) {
      this.say(`[ext] session/update handler threw: ${(e as Error).message}`);
    }
  }

  private request<M extends acp.AgentRequestMethod>(
    method: M,
    params: acp.AgentRequestParamsByMethod[M],
  ): Promise<acp.AgentRequestResponsesByMethod[M]> {
    const conn = this.requireConn();
    if (this.opts.trace) this.say(`[acp →] ${method} ${preview(params)}`);
    return conn.agent.request(method, params);
  }

  private requireConn(): acp.ClientConnection {
    if (!this.conn || this.exited) throw new Error("Hermes is not running");
    return this.conn;
  }

  async newSession(cwd: string): Promise<HermesNewSession> {
    const res = await withTimeout(
      this.request("session/new", { cwd, mcpServers: [] }),
      this.opts.newSessionTimeoutMs ?? 60_000,
      "Hermes (session/new)",
    );
    return res as HermesNewSession;
  }

  /** One page of the sessions Hermes keeps for `cwd`, newest first. */
  listSessions(cwd: string, cursor?: string): Promise<acp.ListSessionsResponse> {
    return withTimeout(
      this.request("session/list", cursor ? { cwd, cursor } : { cwd }),
      this.opts.newSessionTimeoutMs ?? 60_000,
      "Hermes (session/list)",
    );
  }

  /**
   * Reopen a saved session. Hermes streams its whole history as session/update
   * BEFORE it answers, so the caller must already route updates for this id.
   * An unknown id is not an error: Hermes 0.21.5 answers `{}` and replays
   * nothing (`null` is mapped to `undefined`, in case a version sends that).
   */
  async loadSession(cwd: string, sessionId: string): Promise<HermesNewSession | undefined> {
    const res = await withTimeout(
      this.request("session/load", { cwd, sessionId, mcpServers: [] }),
      this.opts.newSessionTimeoutMs ?? 60_000,
      "Hermes (session/load)",
    );
    return (res ?? undefined) as HermesNewSession | undefined;
  }

  /**
   * Switch the session's model; the conversation stays. `session/set_model`
   * left the SDK's typed methods (0.24), so it goes out as a plain request.
   * Hermes refuses while a turn runs (-32603 "Session is busy…") and rejects a
   * model no provider serves (-32602 with details); success is `{}` and no
   * notification follows. Cold, the switch can take ~10 s (model catalogs).
   */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    const conn = this.requireConn();
    if (this.opts.trace) this.say(`[acp →] session/set_model ${modelId}`);
    await withTimeout(
      conn.agent.request("session/set_model", { sessionId, modelId }),
      this.opts.newSessionTimeoutMs ?? 60_000,
      "Hermes (session/set_model)",
    );
  }

  /** Switch the edit-approval mode (Default asks before edits). */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    await withTimeout(
      this.request("session/set_mode", { sessionId, modeId }),
      this.opts.newSessionTimeoutMs ?? 60_000,
      "Hermes (session/set_mode)",
    );
  }

  /** A plain string is one text block; blocks go as they are (text first). */
  prompt(sessionId: string, prompt: string | readonly PromptBlock[]): Promise<acp.PromptResponse> {
    const blocks =
      typeof prompt === "string" ? [{ type: "text" as const, text: prompt }] : [...prompt];
    return this.request("session/prompt", { sessionId, prompt: blocks as acp.ContentBlock[] });
  }

  /** `session/cancel`, awaited until written: a following stdin.end() would
   *  otherwise drop the queued frame (verified with SDK 1.5.0). */
  async cancel(sessionId: string): Promise<void> {
    const conn = this.requireConn();
    if (this.opts.trace) this.say(`[acp →] session/cancel ${sessionId}`);
    await withTimeout(
      conn.agent.notify("session/cancel", { sessionId }),
      CANCEL_WRITE_MS,
      "cancel",
    );
  }

  /**
   * Stop Hermes. Idempotent: a second call returns the first call's promise.
   * Order matters (each step verified in review):
   *   1. cancel the running turn and wait until the cancel is WRITTEN,
   *   2. give the turn ≤ 1.5 s to settle as `cancelled`,
   *   3. close stdin and give Hermes ≤ 2 s to exit on its own,
   *   4. tree-kill on Windows (the launcher's job object uses silent breakaway,
   *      so killing hermes.exe alone leaves MCP servers and tool children).
   */
  shutdown(opts: ShutdownOptions = {}): Promise<void> {
    this.stopPromise ??= this.doShutdown(opts);
    return this.stopPromise;
  }

  private async doShutdown(opts: ShutdownOptions): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || this.exited) return;

    if (opts.cancelSessionId && this.conn) {
      await this.cancel(opts.cancelSessionId).catch((e: unknown) =>
        this.say(`[ext] cancel before shutdown failed: ${(e as Error).message}`),
      );
      if (opts.turnSettled) {
        await Promise.race([opts.turnSettled.catch(() => undefined), sleep(TURN_SETTLE_MS)]);
      }
    }

    if (!this.exited) {
      this.say("[ext] stopping Hermes (closing stdin)…");
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
      await Promise.race([this.exitPromise, sleep(EOF_EXIT_MS)]);
    }

    if (!this.exited) {
      this.say("[ext] Hermes did not exit in time — killing its process tree.");
      await this.killTree(child);
      await Promise.race([this.exitPromise, sleep(KILL_EXIT_MS)]);
    }
  }

  private async killTree(child: ChildProcess): Promise<void> {
    const platform = this.opts.platform ?? process.platform;
    const pid = child.pid;
    if (platform === "win32" && pid !== undefined && child.exitCode === null) {
      // /T walks descendants by parent PID, so it must run while the tree is
      // still intact. Absolute path: never let a PATH entry pick "taskkill".
      const taskkill = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "taskkill.exe",
      );
      const ok = await new Promise<boolean>((resolve) => {
        execFile(
          taskkill,
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, timeout: 2000 },
          (err) => resolve(!err),
        );
      });
      if (ok || this.exited) return;
      this.say("[ext] taskkill failed — falling back to kill().");
    }
    try {
      child.kill();
    } catch {
      // gone
    }
  }
}

/** A short, single-line rendering of a message for the trace log. */
function preview(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > 2000 ? `${s.slice(0, 2000)}… (+${s.length - 2000} chars)` : s;
}
