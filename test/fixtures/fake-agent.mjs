// A scriptable fake Hermes ACP agent for integration tests. Plain Node ESM, no
// dependencies: spawn `process.execPath` with this file wherever the real code
// would spawn `hermes.exe acp` (extra argv such as "acp" is ignored).
//
// It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout the way Hermes
// 0.21.5 does (read from acp_adapter/server.py, and matched against a captured
// real turn in test/fixtures/hermes-wire/turn-reasoning-reply.json):
//   - one frame per line, LF only, pure ASCII: Hermes frames with
//     json.dumps(ensure_ascii=True), so any non-ASCII text (the "·" in
//     model names, for one) arrives as a \uXXXX escape, never as raw UTF-8
//   - requests it sends to the client use integer ids starting at 0, so a
//     client that treats id 0 as "missing" breaks here the way it would there
//   - a line that is not JSON is logged to stderr and skipped, with no reply
//   - log lines go to stderr as "YYYY-MM-DD HH:MM:SS [LEVEL] logger: message"
//
// SCENARIOS: env FAKE_AGENT_SCENARIO (default "stream"). Every scenario handles
// initialize, authenticate, session/new, session/prompt, session/cancel,
// session/load, session/list, session/set_model, session/set_mode,
// session/close and the client's replies to our requests. They differ in what
// a prompt does:
//
//   stream      Real turn shape. First turn of a session only: a
//               session_info_update with the prompt as a provisional title.
//               Then 3 agent_thought_chunks and 5 agent_message_chunks that
//               ALL share one messageId (Hermes has one id allocator for a
//               reply's reasoning and its answer), a tool_call with NO status
//               (Hermes omits it although the tool is already running), a
//               tool_call_update "completed", usage_update, then the response
//               {stopReason:"end_turn", usage:{...cumulative session totals}}.
//               After the first completed turn, ~20 ms AFTER the response, a
//               late session_info_update with title "Fixture Title" (Hermes's
//               auto-title arrives after the turn has ended).
//   slow        Like stream, but 150 ms between frames and a 40-chunk reply
//               (~7 s), for Stop tests. On session/cancel it stops emitting and
//               resolves the prompt with stopReason "cancelled".
//   permission  Thought + message, then per requested approval: a tool_call
//               (no status), then session/request_permission (first id 0).
//               Default request: edit approval "edit-approval-1" (shape from
//               Hermes edit_approval.py: diff content, options allow_once /
//               deny). It waits for the client's reply (logged), then sends
//               tool_call_update for the synthetic id — an id no tool_call ever
//               announced — "completed" if an allow_* option was selected,
//               else "failed". An allowed tool then completes; a denied one is
//               closed at turn end as failed ("ended without a result"). Then a
//               message under a NEW messageId, usage_update, end_turn. A
//               session/cancel during the wait does not abort it (Hermes blocks
//               until answered); the turn then ends "cancelled".
//   reject      Streams a message chunk and a tool_call (left open on purpose,
//               so the client's "running tools become failed" path runs), then
//               session/prompt fails with a JSON-RPC error {code:-32603,
//               message:"Internal error", data:{details:"save_session failed"}}.
//               The process stays alive.
//   refusal     session/prompt resolves {stopReason:"refusal"}, no updates.
//               (Hermes answers that for a session it cannot find — every
//               scenario does the same for an unknown sessionId.)
//   crash       Streams thought chunks and 2 message chunks, prints a
//               traceback to stderr, and exits with code 3. The prompt never
//               resolves.
//   noProvider  initialize lists only the hermes-setup auth method, and
//               session/new fails with {code:-32603, message:"Internal error",
//               data:{details:"No LLM provider configured. Run `hermes model`
//               ..."}} — Hermes's exact text.
//   hangInit    Never answers initialize (for start-timeout tests).
//   ignoreEof   Like stream, but keeps running after stdin EOF until killed
//               (for the kill path). Spawns no children.
//   slashModel  A prompt starting with "/model x" gets one
//               agent_message_chunk with NO messageId, "Model switched to:
//               x\nProvider: Anthropic", then usage_update, then end_turn (no
//               model call; Hermes sends no model notification either). Bare
//               "/model" reports the current model; "/model" during a running
//               turn gets Hermes's busy text. Other prompts behave as in stream.
//   limit       While the session is on an anthropic:* model, a prompt ends as
//               Hermes 0.21.5 ends a turn whose provider stayed rate-limited
//               through every retry: ONE agent_message_chunk with Hermes's
//               failure copy (agent/turn_failure_copy.py, LIMIT_REPLY below),
//               then end_turn — no JSON-RPC error, no _meta, nothing else
//               machine-readable. On any other model, prompts behave as stream.
//
// Any scenario: an idle "/queue <text>" runs the queued text as a nested turn
// inside the slash prompt and always answers end_turn (see runSlashQueue).
//
// Behavior shared by every scenario, as in Hermes:
//   - session/new replies {models, modes, sessionId} and, in the SAME stdout
//     write, available_commands_update + usage_update. A client can therefore
//     see updates for a session id before its session/new call resolves.
//   - session/new without a string cwd and an mcpServers array → -32602.
//   - A prompt while the session's turn is running gets one message chunk
//     "Redirected the active turn with your correction." + end_turn.
//   - An empty prompt → end_turn with no updates.
//   - A completed turn gives the session history: session/list lists it (by
//     cwd, newest first), session/load replays it — user, thought and message
//     chunks WITHOUT messageId, tool_call, tool_call_update — BEFORE its reply
//     {models, modes, _meta}, then the same two notifications as session/new.
//     session/load of an unknown id replies {} (not an error). One persisted
//     session, "0b6f3a52-5c1e-4d7a-9f10-2c8e4b7d9a31" titled "Fix the login
//     redirect", exists from the start, bound to this process's cwd, so a
//     fresh process has something to list and load.
//   - Do not import this file from a test: importing runs the agent.
//   - session/set_model → {}; busy → -32603 "Session is busy; switch models
//     while the session is idle"; unknown model → -32602 with details; unknown
//     session → {}. No notification either way.
//   - session/cancel for an idle or unknown session is logged and ignored.
//   - Unknown methods: logged to stderr, -32601 {data:{method}}. "_"-prefixed
//     requests get result null; "_"-prefixed notifications are dropped.
//   - stdin EOF → exit 0 once stdout has flushed (ignoreEof: keep running).
//
// Other env:
//   FAKE_AGENT_LOG                    File to append every RECEIVED message to
//                                     (format below). Unset → no log.
//   FAKE_AGENT_CHUNK_MS               Delay between streamed frames. Default
//                                     150 for slow, 5 otherwise.
//   FAKE_AGENT_PERMISSION_IDS         permission scenario: which approvals to
//                                     ask for, in order. Comma list of synthetic
//                                     ids ("edit-approval-N" → edit shape,
//                                     "perm-check-N" → dangerous command with 5
//                                     options), or a count N (2 → edit-approval-1,
//                                     perm-check-1). Default "edit-approval-1".
//   FAKE_AGENT_PERMISSION_PARALLEL    "1" → announce all tools and send all
//                                     requests before awaiting any reply.
//   FAKE_AGENT_PERMISSION_TIMEOUT_MS  Give up waiting after this long (Hermes:
//                                     approvals.timeout, 300 s). Hermes then
//                                     sends tool_call_update "failed" for the
//                                     synthetic id and treats it as a deny; a
//                                     late reply is ignored. 0 (default) = wait.
//   FAKE_AGENT_CANCEL_SETTLE_MS       Extra delay before a cancelled prompt
//                                     resolves (a slow-to-settle Hermes).
//
// Log format (FAKE_AGENT_LOG): one JSON object per line, appended
// synchronously the moment each thing is received, so the file order is the
// arrival order:
//   {"seq":1,"hrtime":12.345,"pid":4242,"msg":{...}}          a parsed message
//   {"seq":2,"hrtime":20.001,"pid":4242,"event":"invalid","raw":"..."}
//   {"seq":9,"hrtime":80.125,"pid":4242,"event":"eof"}        stdin closed
// seq starts at 1 per process and has no gaps; hrtime is milliseconds since
// this fake started, from the monotonic clock. pid tells two fakes apart when
// a Restart test writes both to one file. "session/cancel arrived before EOF"
// is: the cancel line's seq < the eof line's seq.

import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// stderr logging. Defined first: config parsing below may need to fail loudly.

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function logLine(level, text) {
  process.stderr.write(`${stamp()} [${level}] fake_agent: ${text}\n`);
}

function die(text) {
  logLine("ERROR", text);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Configuration

const SCENARIOS = new Set([
  "stream",
  "slow",
  "permission",
  "reject",
  "refusal",
  "crash",
  "noProvider",
  "hangInit",
  "ignoreEof",
  "slashModel",
  "limit",
]);
const SCENARIO = process.env.FAKE_AGENT_SCENARIO || "stream";
if (!SCENARIOS.has(SCENARIO)) die(`unknown FAKE_AGENT_SCENARIO "${SCENARIO}"`);

const LOG_FILE = process.env.FAKE_AGENT_LOG || "";
const CHUNK_MS = envInt("FAKE_AGENT_CHUNK_MS", SCENARIO === "slow" ? 150 : 5);
const PERMISSION_IDS = parsePermissionIds(process.env.FAKE_AGENT_PERMISSION_IDS);
const PERMISSION_PARALLEL = process.env.FAKE_AGENT_PERMISSION_PARALLEL === "1";
const PERMISSION_TIMEOUT_MS = envInt("FAKE_AGENT_PERMISSION_TIMEOUT_MS", 0);
const CANCEL_SETTLE_MS = envInt("FAKE_AGENT_CANCEL_SETTLE_MS", 0);

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) die(`${name} must be a whole number >= 0, got "${raw}"`);
  return n;
}

function parsePermissionIds(raw) {
  if (!raw) return ["edit-approval-1"];
  if (/^\d+$/.test(raw)) {
    // A count: alternate the two real request shapes, numbered like Hermes
    // (each kind has its own process-wide counter starting at 1).
    const n = Number(raw);
    return Array.from({ length: n }, (_, i) =>
      i % 2 === 0 ? `edit-approval-${i / 2 + 1}` : `perm-check-${(i + 1) / 2}`,
    );
  }
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!/^(edit-approval|perm-check)-\d+$/.test(id)) {
      die(`FAKE_AGENT_PERMISSION_IDS: "${id}" is not edit-approval-N or perm-check-N`);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Fixed Hermes shapes (trimmed from live responses; see the file header).

const AUTH_PROVIDER = {
  description: "Authenticate Hermes using the currently configured anthropic runtime credentials.",
  id: "anthropic",
  name: "anthropic runtime credentials",
};
const AUTH_SETUP = {
  args: ["--setup"],
  description:
    "Open Hermes' interactive model/provider setup in a terminal. Use this when Hermes has not been configured on this machine yet.",
  id: "hermes-setup",
  name: "Configure Hermes provider",
  type: "terminal",
};

const MODELS = [
  {
    description: "Provider: Anthropic",
    modelId: "anthropic:claude-opus-4-5-20251101",
    name: "Anthropic · claude-opus-4-5-20251101",
  },
  {
    description: "Provider: Anthropic",
    modelId: "anthropic:claude-opus-5-5",
    name: "Anthropic · claude-opus-5-5",
  },
  {
    description: "Provider: ChatGPT or Codex Subscription",
    modelId: "openai-codex:gpt-6-astra",
    name: "ChatGPT or Codex Subscription · gpt-6-astra",
  },
];
const DEFAULT_MODEL_ID = "anthropic:claude-opus-5-5";

const MODES = {
  availableModes: [
    { description: "Ask before edits.", id: "default", name: "Default" },
    {
      description: "Auto-allow workspace and temp-dir edits; still asks for sensitive paths.",
      id: "accept_edits",
      name: "Accept Edits",
    },
    {
      description: "Auto-allow file edits for this session except sensitive paths.",
      id: "dont_ask",
      name: "Don't Ask",
    },
  ],
  currentModeId: "default",
};

const COMMANDS_UPDATE = {
  availableCommands: [
    { description: "List available commands", name: "help" },
    {
      description: "Show current model and provider, or switch models",
      input: { hint: "model name to switch to" },
      name: "model",
    },
    { description: "List available tools with descriptions", name: "tools" },
    { description: "Show conversation message counts by role", name: "context" },
    { description: "Clear conversation history", name: "reset" },
    { description: "Compress conversation context", name: "compress" },
    {
      description: "Inject guidance into the currently running agent turn",
      input: { hint: "guidance for the active turn" },
      name: "steer",
    },
    {
      description: "Queue a prompt to run after the current turn finishes",
      input: { hint: "prompt to run next" },
      name: "queue",
    },
    { description: "Show Hermes version", name: "version" },
  ],
  sessionUpdate: "available_commands_update",
};

const NO_PROVIDER =
  "No LLM provider configured. Run `hermes model` to select a provider, or run `hermes setup` for first-time configuration.";

// The captured real turn's text: markdown, a code fence and a <script> tag, so
// rendering and sanitizing tests get the same input Hermes produced.
const REASONING = ["Thinking about ", "how to greet ", "the user."];
const CONTENT = [
  "# Hello\n\n",
  "Here is **bold** text and ",
  "a list:\n\n- one\n- two\n\n",
  "```ts\nconst x = 1;\n```\n\n",
  "<script>alert(1)</script> done.",
];
const LONG_CONTENT = Array.from(
  { length: 40 },
  (_, i) => `Part ${i + 1} of a long reply that takes a while to stream. `,
);
const LATE_TITLE = "Fixture Title";

const USAGE_SIZE = 1_000_000;
const USAGE_AT_START = 11_263;
const USAGE_PER_TURN = 1_137;

const ABANDONED_TEXT = "This tool call ended without a result (blocked, denied, or interrupted).";

const SEEDED_SESSION_ID = "0b6f3a52-5c1e-4d7a-9f10-2c8e4b7d9a31";

// ---------------------------------------------------------------------------
// Received-message log

const T0 = process.hrtime.bigint();
let seq = 0;

function record(entry) {
  if (!LOG_FILE) return;
  seq += 1;
  const hrtime = Number(process.hrtime.bigint() - T0) / 1e6;
  // Synchronous on purpose: the EOF handler exits right after, and a test must
  // be able to trust that everything received is in the file by then.
  appendFileSync(LOG_FILE, `${JSON.stringify({ seq, hrtime, pid: process.pid, ...entry })}\n`);
}

// ---------------------------------------------------------------------------
// Wire output

function encode(frame) {
  // JSON.stringify already escapes control characters, so everything outside
  // printable ASCII here is non-ASCII text (or DEL): escape it per UTF-16 unit,
  // exactly as Python's ensure_ascii does.
  const json = JSON.stringify(frame).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${json}\n`;
}

// One call = one stdout write, so frames passed together reach the client in
// one chunk (that is how the session/new ordering race is reproduced).
function send(...frames) {
  process.stdout.write(frames.map(encode).join(""));
}

// A client that goes away mid-write must not turn into an EPIPE crash here.
process.stdout.on("error", () => {});

function exitAfterFlush(code) {
  // process.exit() does not wait for a pending pipe write; the write callback
  // fires once everything queued before it has been handed to the OS.
  process.stdout.write("", () => process.exit(code));
}

const rpcReply = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, error) => ({ jsonrpc: "2.0", id, error });
const note = (sessionId, update) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId, update },
});

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
  toJSON() {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

/** Returned by a handler that has already written its own reply (or never will). */
const SENT = Symbol("sent");

// ---------------------------------------------------------------------------
// Update builders (field sets as Hermes's acp_adapter builders emit them;
// absent fields are Hermes's exclude_none serialization, not omissions here).

const textBlock = (text) => ({ text, type: "text" });
const textContent = (text) => [{ content: textBlock(text), type: "content" }];

function thoughtChunk(text, messageId) {
  return messageId
    ? { content: textBlock(text), messageId, sessionUpdate: "agent_thought_chunk" }
    : { content: textBlock(text), sessionUpdate: "agent_thought_chunk" };
}

function messageChunk(text, messageId) {
  return messageId
    ? { content: textBlock(text), messageId, sessionUpdate: "agent_message_chunk" }
    : { content: textBlock(text), sessionUpdate: "agent_message_chunk" };
}

const userChunk = (text) => ({ content: textBlock(text), sessionUpdate: "user_message_chunk" });

const newToolCallId = () => `tc-${randomBytes(6).toString("hex")}`;

// Hermes sends tool_call at execution start with NO status field.
function readToolStart(toolCallId) {
  return {
    kind: "read",
    locations: [{ path: "src/a.ts" }],
    title: "read_file: a.ts",
    toolCallId,
    sessionUpdate: "tool_call",
  };
}

function readToolDone(toolCallId) {
  return {
    content: textContent("Read src/a.ts\n\n```\nexport const a = 1;\n```"),
    kind: "read",
    status: "completed",
    toolCallId,
    sessionUpdate: "tool_call_update",
  };
}

function toolAbandoned(toolCallId, kind) {
  return {
    content: textContent(ABANDONED_TEXT),
    kind,
    status: "failed",
    toolCallId,
    sessionUpdate: "tool_call_update",
  };
}

// The two real approval shapes, each with the tool_call Hermes announces
// before asking and the completion it sends if the answer was an allow.
function approvalPlan(synthId) {
  const toolCallId = newToolCallId();
  if (synthId.startsWith("edit-approval-")) {
    return {
      synthId,
      toolCallId,
      kind: "edit",
      start: {
        content: textContent(
          "Preparing replace edit for src/a.ts. Approval prompt shows the diff.",
        ),
        kind: "edit",
        locations: [{ path: "src/a.ts" }],
        title: "patch: src/a.ts",
        toolCallId,
        sessionUpdate: "tool_call",
      },
      toolCall: {
        content: [
          {
            newText: "export const a = 2;\n",
            oldText: "export const a = 1;\n",
            path: "src/a.ts",
            type: "diff",
          },
        ],
        kind: "edit",
        rawInput: {
          arguments: {
            new_string: "export const a = 2;",
            old_string: "export const a = 1;",
            path: "src/a.ts",
          },
          tool: "patch",
        },
        status: "pending",
        title: "Approve edit: src/a.ts",
        toolCallId: synthId,
      },
      options: [
        { kind: "allow_once", name: "Allow edit", optionId: "allow_once" },
        { kind: "reject_once", name: "Deny", optionId: "deny" },
      ],
      done: {
        content: textContent("Edited src/a.ts (1 replacement)"),
        kind: "edit",
        status: "completed",
        toolCallId,
        sessionUpdate: "tool_call_update",
      },
    };
  }
  return {
    synthId,
    toolCallId,
    kind: "execute",
    start: {
      content: textContent("$ rm -rf build"),
      kind: "execute",
      locations: [],
      title: "terminal: rm -rf build",
      toolCallId,
      sessionUpdate: "tool_call",
    },
    toolCall: {
      content: textContent("recursive delete\n$ rm -rf build"),
      kind: "execute",
      rawInput: { command: "rm -rf build", description: "recursive delete" },
      status: "pending",
      title: "recursive delete: rm -rf build",
      toolCallId: synthId,
    },
    options: [
      { kind: "allow_once", name: "Allow once", optionId: "allow_once" },
      { kind: "allow_always", name: "Allow for session", optionId: "allow_session" },
      { kind: "allow_always", name: "Allow always", optionId: "allow_always" },
      { kind: "reject_once", name: "Deny", optionId: "deny" },
      { kind: "reject_always", name: "Deny always", optionId: "deny_always" },
    ],
    done: {
      content: textContent("$ rm -rf build\n(exit code 0)"),
      kind: "execute",
      status: "completed",
      toolCallId,
      sessionUpdate: "tool_call_update",
    },
  };
}

// ---------------------------------------------------------------------------
// Sessions and turns

const sessions = new Map();

function createSession(cwd, id = randomUUID()) {
  const s = {
    id,
    cwd,
    modelId: DEFAULT_MODEL_ID,
    title: null,
    modelTitled: false,
    updatedAt: null,
    history: [],
    used: USAGE_AT_START,
    tokens: { input: 0, output: 0 },
    turn: null,
  };
  sessions.set(id, s);
  return s;
}

// A persisted session from "an earlier run", so session/list and session/load
// have something to find in a fresh process. Replayed chunks carry no
// messageId: Hermes rebuilds them from stored history, which keeps none.
{
  const s = createSession(process.cwd(), SEEDED_SESSION_ID);
  s.title = "Fix the login redirect";
  s.modelTitled = true;
  s.updatedAt = "2026-09-20T11:17:17.940042+00:00";
  s.history = [
    userChunk("fix the login redirect"),
    thoughtChunk("The redirect probably drops the return URL."),
    messageChunk("I'll look at src/auth.ts first."),
    {
      kind: "read",
      locations: [{ path: "src/auth.ts" }],
      title: "read_file: auth.ts",
      toolCallId: "tc-5a1b2c3d4e5f",
      sessionUpdate: "tool_call",
    },
    {
      content: textContent("Read src/auth.ts\n\n```\nredirect(returnTo ?? '/');\n```"),
      kind: "read",
      status: "completed",
      toolCallId: "tc-5a1b2c3d4e5f",
      sessionUpdate: "tool_call_update",
    },
    messageChunk("Fixed: the redirect now keeps `returnTo`."),
  ];
}

function modelState(currentId) {
  // Hermes marks the current model only through its description.
  return {
    availableModels: MODELS.map((m) => ({
      ...m,
      description: m.modelId === currentId ? `${m.description} • current` : m.description,
    })),
    currentModelId: currentId,
  };
}

function findModel(requested) {
  if (typeof requested !== "string") return undefined;
  return (
    MODELS.find((m) => m.modelId === requested) ??
    MODELS.find((m) => m.modelId.split(":")[1] === requested)
  );
}

const usageUpdate = (s) => ({ size: USAGE_SIZE, used: s.used, sessionUpdate: "usage_update" });

function provenance(sessionId) {
  return {
    hermes: {
      sessionProvenance: {
        acpSessionId: sessionId,
        currentHermesSessionId: sessionId,
        rootHermesSessionId: sessionId,
        parentHermesSessionId: null,
        sessionKind: "root",
        compressionDepth: 0,
      },
    },
  };
}

function titleUpdate(s) {
  return {
    _meta: provenance(s.id),
    title: s.title,
    updatedAt: new Date().toISOString(),
    sessionUpdate: "session_info_update",
  };
}

function emit(s, update) {
  send(note(s.id, update));
}

class Turn {
  constructor(session, text) {
    this.session = session;
    this.text = text;
    this.cancelled = false;
    /** Tools announced and not yet completed: toolCallId → kind. */
    this.openTools = new Map();
    this.wakers = new Set();
  }

  cancel() {
    this.cancelled = true;
    for (const wake of this.wakers) wake();
  }

  /** Sleep between frames; a cancel wakes it at once, like Hermes's hard interrupt. */
  sleep(ms) {
    if (this.cancelled || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wakers.add(wake);
    });
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function promptText(prompt) {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Hermes's turn prologue sets a provisional title from the first prompt. */
function sendPrologueTitle(turn) {
  const s = turn.session;
  if (s.title) return;
  s.title = turn.text.split("\n")[0].slice(0, 80);
  emit(s, titleUpdate(s));
}

// Mirrors Hermes's turn epilogue: close tools the turn left open, report
// usage, go idle, reply. Returns SENT because it writes the reply itself.
async function finishTurn(turn, id, stopReason, history) {
  const s = turn.session;
  if (stopReason === "cancelled" && CANCEL_SETTLE_MS > 0) await delay(CANCEL_SETTLE_MS);
  for (const [toolCallId, kind] of turn.openTools) emit(s, toolAbandoned(toolCallId, kind));
  turn.openTools.clear();
  if (history && stopReason === "end_turn") {
    s.history.push(userChunk(turn.text), ...history);
    s.updatedAt = new Date().toISOString();
  }
  s.used += USAGE_PER_TURN;
  s.tokens.input += 50;
  s.tokens.output += 20;
  s.turn = null;
  const usage = {
    cachedReadTokens: 0,
    inputTokens: s.tokens.input,
    outputTokens: s.tokens.output,
    thoughtTokens: 0,
    totalTokens: s.tokens.input + s.tokens.output,
  };
  send(note(s.id, usageUpdate(s)), rpcReply(id, { stopReason, usage }));
  if (stopReason === "end_turn" && !s.modelTitled) {
    s.modelTitled = true;
    // Hermes's auto-title call runs after the turn; its update lands after the
    // response (21 ms after it on the captured wire).
    setTimeout(() => {
      s.title = LATE_TITLE;
      emit(s, titleUpdate(s));
    }, 20);
  }
  return SENT;
}

// ---------------------------------------------------------------------------
// Scenario turn runners

async function runStreamTurn(turn, id, content) {
  const s = turn.session;
  const messageId = randomUUID();
  sendPrologueTitle(turn);
  await turn.sleep(CHUNK_MS);
  for (const text of REASONING) {
    if (turn.cancelled) return finishTurn(turn, id, "cancelled");
    emit(s, thoughtChunk(text, messageId));
    await turn.sleep(CHUNK_MS);
  }
  for (const text of content) {
    if (turn.cancelled) return finishTurn(turn, id, "cancelled");
    emit(s, messageChunk(text, messageId));
    await turn.sleep(CHUNK_MS);
  }
  if (turn.cancelled) return finishTurn(turn, id, "cancelled");
  const toolCallId = newToolCallId();
  emit(s, readToolStart(toolCallId));
  turn.openTools.set(toolCallId, "read");
  await turn.sleep(CHUNK_MS);
  if (turn.cancelled) return finishTurn(turn, id, "cancelled");
  emit(s, readToolDone(toolCallId));
  turn.openTools.delete(toolCallId);
  return finishTurn(turn, id, "end_turn", [
    thoughtChunk(REASONING.join("")),
    messageChunk(content.join("")),
    readToolStart(toolCallId),
    readToolDone(toolCallId),
  ]);
}

let nextClientRequestId = 0; // Hermes numbers its own requests from 0
const pendingClientRequests = new Map();

/** Ask the client; resolves once answered or timed out, after sending the
 *  synthetic tool_call_update Hermes uses to close the approval bubble. */
function askPermission(s, plan) {
  const requestId = nextClientRequestId++;
  send({
    jsonrpc: "2.0",
    id: requestId,
    method: "session/request_permission",
    params: { options: plan.options, sessionId: s.id, toolCall: plan.toolCall },
  });
  return new Promise((resolve) => {
    let timer;
    const settle = (response, timedOut) => {
      clearTimeout(timer);
      pendingClientRequests.delete(requestId);
      const outcome = response?.result?.outcome;
      // Approval is decided by the chosen option's kind, as in Hermes; an
      // error reply, "cancelled" or an unknown optionId is a deny.
      const allowed =
        !timedOut &&
        outcome?.outcome === "selected" &&
        plan.options.some((o) => o.optionId === outcome.optionId && o.kind.startsWith("allow"));
      const answer = timedOut ? "timed out" : JSON.stringify(response.result ?? response.error);
      logLine("INFO", `permission ${plan.synthId}: ${answer} -> ${allowed ? "allow" : "deny"}`);
      emit(s, {
        status: allowed ? "completed" : "failed",
        toolCallId: plan.synthId,
        sessionUpdate: "tool_call_update",
      });
      resolve(allowed);
    };
    pendingClientRequests.set(requestId, (msg) => settle(msg, false));
    if (PERMISSION_TIMEOUT_MS > 0) {
      timer = setTimeout(() => {
        logLine("WARNING", `Permission request timed out after ${PERMISSION_TIMEOUT_MS} ms`);
        settle(null, true);
      }, PERMISSION_TIMEOUT_MS);
    }
  });
}

async function runPermissionTurn(turn, id) {
  const s = turn.session;
  const firstId = randomUUID();
  sendPrologueTitle(turn);
  await turn.sleep(CHUNK_MS);
  emit(s, thoughtChunk("The user wants a change that needs approval.", firstId));
  await turn.sleep(CHUNK_MS);
  emit(s, messageChunk("I'll make the change.", firstId));
  await turn.sleep(CHUNK_MS);

  const plans = PERMISSION_IDS.map(approvalPlan);
  const results = [];
  const announce = (plan) => {
    emit(s, plan.start);
    turn.openTools.set(plan.toolCallId, plan.kind);
  };
  const complete = (plan, allowed) => {
    results.push(allowed);
    // A denied tool reports nothing; finishTurn closes it as abandoned.
    if (!allowed) return;
    emit(s, plan.done);
    turn.openTools.delete(plan.toolCallId);
  };
  if (PERMISSION_PARALLEL) {
    for (const plan of plans) announce(plan);
    const answers = await Promise.all(plans.map((plan) => askPermission(s, plan)));
    for (const [i, plan] of plans.entries()) complete(plan, answers[i]);
  } else {
    for (const plan of plans) {
      announce(plan);
      await turn.sleep(CHUNK_MS);
      complete(plan, await askPermission(s, plan));
      if (turn.cancelled) break;
      await turn.sleep(CHUNK_MS);
    }
  }
  if (turn.cancelled) return finishTurn(turn, id, "cancelled");

  // Hermes closes the messageId before running tools, so text after them is a
  // new message.
  const allAllowed = results.every(Boolean);
  const closing = allAllowed ? "Done." : "That was denied, so I stopped there.";
  emit(s, messageChunk(closing, randomUUID()));
  return finishTurn(turn, id, "end_turn", [
    thoughtChunk("The user wants a change that needs approval."),
    messageChunk("I'll make the change."),
    messageChunk(closing),
  ]);
}

// Hermes's copy for "retries exhausted on a rate limit" with a known reset
// (turn_failure_copy.py:172-179, 363-389), assembled as Hermes assembles it.
const LIMIT_REPLY =
  "Anthropic rate-limited every one of 3 attempts — its usage limit resets in ~2h. " +
  "Send /retry after that, or switch models with /model. To avoid this in future, " +
  "add a backup provider with `hermes fallback add`.\n\n" +
  "Provider said: HTTP 429: This request would exceed your account's rate limit.\n\n" +
  "Limit resets at 14:10 (in 2h 05m).";

async function runLimitTurn(turn, id) {
  await turn.sleep(CHUNK_MS);
  emit(turn.session, messageChunk(LIMIT_REPLY, randomUUID()));
  // Hermes keeps the request in history as "not processed"; no reply to replay.
  return finishTurn(turn, id, "end_turn", null);
}

async function runRejectTurn(turn) {
  const s = turn.session;
  emit(s, messageChunk("Working on it.", randomUUID()));
  await turn.sleep(CHUNK_MS);
  emit(s, readToolStart(newToolCallId()));
  await turn.sleep(CHUNK_MS);
  // As when Hermes's save_session raises after the turn: the exception becomes
  // a JSON-RPC error and the process lives on.
  s.turn = null;
  throw new RpcError(-32603, "Internal error", { details: "save_session failed" });
}

async function runCrashTurn(turn) {
  const s = turn.session;
  const messageId = randomUUID();
  for (const text of REASONING) {
    emit(s, thoughtChunk(text, messageId));
    await turn.sleep(CHUNK_MS);
  }
  for (const text of CONTENT.slice(0, 2)) {
    emit(s, messageChunk(text, messageId));
    await turn.sleep(CHUNK_MS);
  }
  process.stderr.write(
    "Traceback (most recent call last):\n" +
      '  File "acp_adapter/server.py", line 870, in prompt\n' +
      "RuntimeError: simulated crash (fake agent scenario 'crash')\n",
  );
  exitAfterFlush(3);
  return new Promise(() => {}); // the prompt never resolves
}

/**
 * `/queue <text>` (any scenario), as Hermes runs it while idle: the slash reply
 * "Queued for the next turn. (1 queued)" (no messageId) and usage_update, then
 * Hermes drains the queue BEFORE answering the slash prompt — the queued text
 * is echoed as a user_message_chunk and runs as a nested turn whose result is
 * discarded. The outer prompt always ends end_turn, even when the nested turn
 * was cancelled (server.py:829-839, 1003-1013); Hermes then keeps the stopped
 * text and prepends it to the next prompt (server.py:644-646, 723-724).
 */
async function runSlashQueue(s, text, id) {
  const queued = text.replace(/^\/queue\s+/, "");
  send(
    note(s.id, messageChunk("Queued for the next turn. (1 queued)")),
    note(s.id, usageUpdate(s)),
  );
  const turn = new Turn(s, queued);
  s.turn = turn;
  emit(s, userChunk(queued));
  const messageId = randomUUID();
  for (const t of SCENARIO === "slow" ? LONG_CONTENT : CONTENT) {
    if (turn.cancelled) break;
    emit(s, messageChunk(t, messageId));
    await turn.sleep(CHUNK_MS);
  }
  if (turn.cancelled) logLine("INFO", `queued turn cancelled; stored for the next prompt`);
  s.turn = null;
  send(note(s.id, usageUpdate(s)), rpcReply(id, { stopReason: "end_turn" }));
  return SENT;
}

function runSlashModel(s, text, id) {
  const arg = text.slice("/model".length).trim();
  let reply;
  if (s.turn) {
    // Hermes refuses state-mutating commands mid-turn (commands.py).
    reply =
      "⏳ Session is busy; /model only works while the session is idle. " +
      "Wait for the current response or cancel first.";
  } else if (!arg) {
    reply = `Current model: ${s.modelId.split(":")[1]}\nProvider: Anthropic`;
  } else {
    reply = `Model switched to: ${arg}\nProvider: Anthropic`;
    const model = findModel(arg);
    if (model) s.modelId = model.modelId;
  }
  // Slash replies carry no messageId; Hermes sends usage right after.
  send(
    note(s.id, messageChunk(reply)),
    note(s.id, usageUpdate(s)),
    rpcReply(id, { stopReason: "end_turn" }),
  );
  return SENT;
}

// ---------------------------------------------------------------------------
// Request handlers

function requireParams(params, shape) {
  for (const [key, type] of Object.entries(shape)) {
    const value = params[key];
    const ok = type === "array" ? Array.isArray(value) : typeof value === type;
    if (!ok) {
      throw new RpcError(-32602, "Invalid params", { details: `${key}: expected ${type}` });
    }
  }
}

function onInitialize(params) {
  if (SCENARIO === "hangInit") {
    logLine("INFO", "hangInit: not answering initialize");
    return SENT;
  }
  const client = params.clientInfo?.name ?? "unknown";
  logLine("INFO", `Initialize from ${client} (protocol v${params.protocolVersion})`);
  // Hermes answers protocolVersion 1 whatever was asked and never reads
  // clientCapabilities. Without a provider, only the setup method is listed.
  return {
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
      sessionCapabilities: { fork: {}, list: {}, resume: {} },
    },
    agentInfo: { name: "hermes-agent", version: "0.21.5" },
    authMethods: SCENARIO === "noProvider" ? [AUTH_SETUP] : [AUTH_PROVIDER, AUTH_SETUP],
    protocolVersion: 1,
  };
}

function onSessionNew(params, id) {
  requireParams(params, { cwd: "string", mcpServers: "array" });
  if (SCENARIO === "noProvider") {
    throw new RpcError(-32603, "Internal error", { details: NO_PROVIDER });
  }
  const s = createSession(params.cwd);
  logLine("INFO", `New session ${s.id} (cwd=${s.cwd})`);
  send(
    rpcReply(id, { models: modelState(s.modelId), modes: MODES, sessionId: s.id }),
    note(s.id, COMMANDS_UPDATE),
    note(s.id, usageUpdate(s)),
  );
  return SENT;
}

function onSessionLoad(params, id) {
  requireParams(params, { sessionId: "string", cwd: "string", mcpServers: "array" });
  const s = sessions.get(params.sessionId);
  if (!s) {
    logLine("WARNING", `load_session: session ${params.sessionId} not found`);
    return {};
  }
  s.cwd = params.cwd; // Hermes overwrites the stored cwd on load
  // History streams BEFORE the reply, one frame per update.
  for (const update of s.history) emit(s, update);
  const result = { models: modelState(s.modelId), modes: MODES };
  // _meta needs a database row, which exists only once there is history.
  if (s.history.length > 0) result._meta = provenance(s.id);
  send(rpcReply(id, result), note(s.id, COMMANDS_UPDATE), note(s.id, usageUpdate(s)));
  return SENT;
}

// Hermes compares cwds after mapping to /mnt/c/... + realpath: drive-letter
// case, slash style and a trailing slash do not matter; the rest is
// case-sensitive.
function normCwd(p) {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/^([a-zA-Z]):/, (_, d) => `${d.toLowerCase()}:`);
}

const LIST_PAGE = 50;

function onSessionList(params) {
  const want = typeof params.cwd === "string" ? normCwd(params.cwd) : null;
  const rows = [...sessions.values()]
    .filter((s) => s.history.length > 0 && (want === null || normCwd(s.cwd) === want))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let start = 0;
  if (typeof params.cursor === "string") {
    const i = rows.findIndex((s) => s.id === params.cursor);
    if (i === -1) return { sessions: [] }; // unknown cursor → empty page, never the full list
    start = i + 1;
  }
  const page = rows.slice(start, start + LIST_PAGE);
  const result = {
    sessions: page.map((s) => ({
      cwd: s.cwd,
      sessionId: s.id,
      ...(s.title ? { title: s.title } : {}),
      updatedAt: s.updatedAt,
    })),
  };
  if (rows.length - start > LIST_PAGE) result.nextCursor = page[page.length - 1].id;
  return result;
}

function onSetModel(params) {
  const s = sessions.get(params.sessionId);
  if (!s) return {};
  if (s.turn) {
    throw new RpcError(-32603, "Session is busy; switch models while the session is idle");
  }
  const model = findModel(params.modelId);
  if (!model) {
    throw new RpcError(-32602, "Invalid params", {
      details: `Model '${params.modelId}' is not available from any configured provider.`,
    });
  }
  s.modelId = model.modelId;
  logLine("INFO", `Session ${s.id}: model switched to ${model.modelId}`);
  return {};
}

async function onSessionPrompt(params, id) {
  const s = sessions.get(params.sessionId);
  if (!s) {
    logLine("ERROR", `prompt: session ${params.sessionId} not found`);
    return { stopReason: "refusal" };
  }
  const text = promptText(params.prompt);
  if (!text) return { stopReason: "end_turn" };
  // Slash commands are dispatched before the busy check, as in Hermes.
  if (SCENARIO === "slashModel" && /^\/model(\s|$)/.test(text)) return runSlashModel(s, text, id);
  if (!s.turn && /^\/queue\s+\S/.test(text)) return runSlashQueue(s, text, id);
  // A local command, as in Hermes: one text chunk (no messageId), a usage
  // update, end_turn, nothing added to the history.
  if (text === "/context") {
    emit(
      s,
      messageChunk(
        [
          "Conversation: 4 messages",
          "  user: 2, assistant: 2, tool: 0, system: 0",
          `Model: ${s.modelId.split(":").slice(1).join(":")}`,
          "Provider: anthropic",
          "Context usage: ~29,123 / 1,000,000 tokens (2.9%)",
          "Compression: ~770,877 tokens until threshold (~800,000, 80%).",
          "Tip: run /compress to compress manually before the threshold.",
        ].join("\n"),
      ),
    );
    return { stopReason: "end_turn" };
  }
  if (s.turn) {
    emit(s, messageChunk("Redirected the active turn with your correction."));
    return { stopReason: "end_turn" };
  }
  if (SCENARIO === "refusal") return { stopReason: "refusal" };

  const turn = new Turn(s, text);
  s.turn = turn;
  logLine("INFO", `Prompt on session ${s.id}: ${text.slice(0, 100)}`);
  switch (SCENARIO) {
    case "slow":
      return runStreamTurn(turn, id, LONG_CONTENT);
    case "permission":
      return runPermissionTurn(turn, id);
    case "reject":
      return runRejectTurn(turn);
    case "crash":
      return runCrashTurn(turn);
    case "limit":
      if (s.modelId.startsWith("anthropic:")) return runLimitTurn(turn, id);
      return runStreamTurn(turn, id, CONTENT);
    default:
      return runStreamTurn(turn, id, CONTENT);
  }
}

const REQUEST_HANDLERS = {
  initialize: onInitialize,
  authenticate: () => ({}), // Hermes: success and failure both look like {}
  "session/new": onSessionNew,
  "session/load": onSessionLoad,
  "session/list": onSessionList,
  "session/prompt": onSessionPrompt,
  "session/set_model": onSetModel,
  "session/set_mode": () => ({}), // unknown modes silently become "default"
  "session/close": () => ({}), // a no-op in Hermes
};

function onCancel(params) {
  const s = sessions.get(params?.sessionId);
  if (!s?.turn) {
    logLine("INFO", `session/cancel for idle or unknown session ${params?.sessionId}`);
    return;
  }
  logLine("INFO", `Cancelled session ${s.id}`);
  s.turn.cancel();
}

// ---------------------------------------------------------------------------
// Dispatch

async function handleRequest(msg) {
  const handler = Object.hasOwn(REQUEST_HANDLERS, msg.method)
    ? REQUEST_HANDLERS[msg.method]
    : undefined;
  if (!handler) {
    if (msg.method.startsWith("_")) {
      send(rpcReply(msg.id, null)); // the SDK's ext_method stub answers null
      return;
    }
    logLine("WARNING", `unknown method "${msg.method}" (id ${JSON.stringify(msg.id)})`);
    send(
      rpcError(msg.id, { code: -32601, message: "Method not found", data: { method: msg.method } }),
    );
    return;
  }
  try {
    const result = await handler(msg.params ?? {}, msg.id);
    if (result !== SENT) send(rpcReply(msg.id, result));
  } catch (err) {
    if (err instanceof RpcError) {
      send(rpcError(msg.id, err.toJSON()));
    } else {
      logLine("ERROR", `handler for ${msg.method} threw: ${err?.stack ?? err}`);
      send(
        rpcError(msg.id, {
          code: -32603,
          message: "Internal error",
          data: { details: String(err) },
        }),
      );
    }
  }
}

function handleMessage(msg) {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    logLine("WARNING", `ignoring non-object message ${JSON.stringify(msg)}`);
    return;
  }
  if (typeof msg.method === "string") {
    if ("id" in msg) {
      void handleRequest(msg);
    } else if (msg.method === "session/cancel") {
      onCancel(msg.params);
    } else if (!msg.method.startsWith("_")) {
      logLine("WARNING", `unknown notification "${msg.method}"`);
    }
    return;
  }
  if ("id" in msg && ("result" in msg || "error" in msg)) {
    const settle = pendingClientRequests.get(msg.id);
    if (settle) settle(msg);
    else logLine("WARNING", `reply for unknown or expired request id ${JSON.stringify(msg.id)}`);
    return;
  }
  logLine("WARNING", `ignoring message that is neither request nor reply: ${JSON.stringify(msg)}`);
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    record({ event: "invalid", raw: line });
    logLine("ERROR", `invalid JSON on stdin, skipped: ${line.slice(0, 200)}`);
    return;
  }
  record({ msg });
  handleMessage(msg);
}

let inbox = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inbox += chunk;
  let nl = inbox.indexOf("\n");
  while (nl !== -1) {
    const line = inbox.slice(0, nl).replace(/\r$/, "");
    inbox = inbox.slice(nl + 1);
    if (line.trim()) handleLine(line);
    nl = inbox.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  // Python's readline hands over an unterminated last line before EOF.
  if (inbox.trim()) handleLine(inbox.replace(/\r$/, ""));
  inbox = "";
  record({ event: "eof" });
  if (SCENARIO === "ignoreEof") {
    logLine("INFO", "stdin closed; ignoreEof keeps running until killed");
    setInterval(() => {}, 60_000); // nothing else holds the event loop open now
    return;
  }
  logLine("INFO", "stdin closed; exiting");
  exitAfterFlush(0);
});

logLine(
  "INFO",
  `Starting fake hermes-agent ACP adapter (scenario=${SCENARIO}, pid=${process.pid})`,
);
