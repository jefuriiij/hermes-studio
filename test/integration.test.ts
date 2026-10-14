// The real ChatController + HermesClient, driven against the fake ACP agent
// (test/fixtures/fake-agent.mjs), which reproduces Hermes 0.21.5's wire
// behavior: shared messageIds, status-less tool_calls, notifications written in
// the same chunk as the session/new response, permission ids from 0, and so on.
// Each test pins one behavior the slice-1 review found missing from v1.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyOps,
  type ChatItem,
  type ChatModel,
  type ChatOp,
  emptyModel,
} from "../src/shared/chat";
import {
  type ControllerDeps,
  ChatController,
  STOPPED_NOTICE,
  type TurnDone,
} from "../src/host/chatController";
import { HermesClient, type HermesClientOptions } from "../src/host/hermesClient";
import type { Attachment } from "../src/logic/attachments";
import type { BackgroundSession } from "../src/shared/protocol";

const FAKE = join(__dirname, "fixtures", "fake-agent.mjs");

interface LogLine {
  seq: number;
  pid: number;
  msg?: {
    method?: string;
    id?: number | string;
    params?: Record<string, unknown>;
    result?: unknown;
  };
  event?: string;
}

interface Harness {
  ctl: ChatController;
  log: () => LogLine[];
  pids: number[];
  lines: string[];
  /** Cards held open by `answer: () => "hold"`; `answer` clicks one. */
  asked: { id: string; answer: (optionId: string | undefined) => boolean }[];
  /** Make every later log write throw, as VS Code's disposed output channel does. */
  breakLog: () => void;
  /** Every op batch the controller emitted, after a JSON round trip (what
   *  VS Code's postMessage delivers to the webview), applied to a mirror. */
  mirror: () => ChatModel;
  /** Chats left working in the background: every published list, the
   *  approvals they asked for (cards NOT clicked), and how each one ended. */
  bg: {
    lists: BackgroundSession[][];
    asks: { itemId: string; session: BackgroundSession }[];
    done: { session: BackgroundSession; outcome: "done" | "failed" }[];
    /** Foreground cards (onPermission) seen, clicked or held. */
    foregroundAsks: number;
    /** Turns of the chat on screen that ended (onTurnDone: the notifications). */
    turns: TurnDone[];
    /** Queued messages handed back to the composer (onQueueReturned). */
    returned: string[];
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function harness(
  scenario: string | (() => string),
  opts: {
    env?: Record<string, string>;
    client?: Partial<HermesClientOptions>;
    answer?: (n: number) => string | undefined | "hold";
    /** Workspace folder path (default: a fresh temp dir). */
    folder?: string;
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "hs-int-"));
  const logFile = join(dir, "agent.log");
  const pids: number[] = [];
  const lines: string[] = [];
  const asked: Harness["asked"] = [];
  let askCount = 0;
  let logBroken = false;
  let mirror = emptyModel();
  const bg: Harness["bg"] = {
    lists: [],
    asks: [],
    done: [],
    foregroundAsks: 0,
    turns: [],
    returned: [],
  };

  const deps: ControllerDeps = {
    folder: () => ({ path: opts.folder ?? dir, name: "work" }),
    launch: () => ({
      ok: true,
      command: process.execPath,
      args: [FAKE, "acp"],
      env: {
        ...(process.env as Record<string, string>),
        FAKE_AGENT_SCENARIO: typeof scenario === "function" ? scenario() : scenario,
        FAKE_AGENT_LOG: logFile,
        ...opts.env,
      },
    }),
    createClient: (o) => {
      const c = new HermesClient({ ...o, ...opts.client });
      const start = c.start.bind(c);
      c.start = async () => {
        const r = start();
        // record the pid as soon as it exists
        setImmediate(() => c.pid !== undefined && pids.push(c.pid));
        return r;
      };
      return c;
    },
    trace: () => false,
    log: (l) => {
      if (logBroken) throw new Error("Channel has been closed");
      lines.push(l);
    },
    onStderrLine: () => {
      if (logBroken) throw new Error("Channel has been closed");
    },
    // A card appeared: "click" like a user would, a moment later (never from
    // inside the notification itself).
    onPermission: (item) => {
      bg.foregroundAsks++;
      const n = askCount++;
      const a = opts.answer ? opts.answer(n) : "allow_once";
      const click = (optionId: string | undefined) => ctl.answerPermission(item.id, optionId);
      if (a === "hold") asked.push({ id: item.id, answer: click });
      else setImmediate(() => click(a));
    },
    onBackgroundPermission: (item, session) => bg.asks.push({ itemId: item.id, session }),
    onBackgroundDone: (session, outcome) => bg.done.push({ session, outcome }),
    onBackgroundChange: (list) => bg.lists.push(list),
    onTurnDone: (d) => bg.turns.push(d),
    onQueueReturned: (items) => bg.returned.push(...items.map((q) => q.text)),
    now: () => Date.now(),
  };
  const ctl = new ChatController(deps);
  ctl.onChange((ops) => {
    mirror = applyOps(mirror, JSON.parse(JSON.stringify(ops)) as ChatOp[]);
  });
  cleanups.push(async () => {
    await ctl.shutdown();
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    ctl,
    pids,
    lines,
    asked,
    breakLog: () => {
      logBroken = true;
    },
    mirror: () => mirror,
    bg,
    log: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as LogLine)
        : [],
  };
}

async function waitFor(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const items = (h: Harness): ChatItem[] => h.ctl.model.items;
const texts = (h: Harness, kind: ChatItem["kind"]) =>
  items(h)
    .filter((i) => i.kind === kind)
    .map((i) => ("text" in i ? i.text : ""));
const methods = (h: Harness) => h.log().map((l) => l.msg?.method ?? l.event ?? "(reply)");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a normal turn", () => {
  it("streams thought and answer as separate items and ends cleanly", async () => {
    const h = harness("stream");
    await h.ctl.send("hello");
    const m = h.ctl.model;
    expect(m.meta.busy).toBe(false);
    expect(m.meta.connection).toEqual({ state: "ready" });
    expect(items(h).map((i) => i.kind)).toEqual(["user", "thought", "assistant", "tool"]);
    expect(new Set(items(h).map((i) => i.id)).size).toBe(items(h).length);
    expect(items(h)[3]).toMatchObject({ kind: "tool", status: "completed" });
    expect(m.meta.usage?.size).toBeGreaterThan(0);
    expect(m.meta.model).toBeTruthy();
    // Hermes's auto-title lands ~20 ms after the prompt response.
    await waitFor("late title", () => h.ctl.model.meta.title === "Fixture Title");
  });

  // Hermes writes usage/commands in the same chunk as the session/new reply,
  // so they can arrive before the controller knows the session id.
  it("keeps the notifications that arrive with the session/new response", async () => {
    const h = harness("stream");
    h.ctl.viewVisible();
    await waitFor("ready", () => h.ctl.model.meta.connection.state === "ready");
    expect(h.ctl.model.meta.usage).toBeDefined();
  });

  it("updates the header model after a typed /model command", async () => {
    const h = harness("slashModel");
    await h.ctl.send("/model gpt-6-astra");
    expect(h.ctl.model.meta.model).toBe("gpt-6-astra");
    // …and the menu's check mark moves with it.
    expect(h.ctl.model.meta.modelId).toBe("openai-codex:gpt-6-astra");
  });
});

describe("telling the user a turn ended (notifications)", () => {
  it("a finished turn: its session, its name, how long it took", async () => {
    const h = harness("stream");
    await h.ctl.send("hello");
    expect(h.bg.turns).toHaveLength(1);
    const d = h.bg.turns[0];
    expect(d?.sessionId).toBe(h.ctl.model.meta.sessionId);
    expect(d?.why).toBeUndefined();
    expect(d?.title).toBeTruthy();
    expect(d?.ms).toBeGreaterThanOrEqual(0);
  });

  it("a usage limit is a stop, with the limit in a few words", async () => {
    const h = harness("limit");
    await h.ctl.send("fix the login redirect");
    expect(h.bg.turns.map((d) => d.why)).toEqual([
      "Anthropic usage limit — resets at 14:10 (in 2h 05m)",
    ]);
  });

  it("nothing for a turn you stopped yourself", async () => {
    const h = harness("slow");
    const turn = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    await h.ctl.stop();
    await turn;
    expect(h.bg.turns).toEqual([]);
  });

  it("nothing for a message that never reached Hermes", async () => {
    const h = harness("stream");
    const turn = h.ctl.send("hello");
    await h.ctl.stop();
    await turn;
    expect(h.bg.turns).toEqual([]);
  });
});

describe("messages typed while Hermes works (the queue)", () => {
  const quick = { env: { FAKE_AGENT_CHUNK_MS: "10" } };
  const queue = (h: Harness) => h.ctl.model.meta.queue ?? [];
  const prompts = (h: Harness) =>
    h
      .log()
      .filter((l) => l.msg?.method === "session/prompt")
      .map((l) => JSON.stringify(l.msg?.params?.prompt ?? []));

  it("waits for the reply to end, then goes out as the next message", async () => {
    const h = harness("slow", quick);
    const first = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    expect(h.ctl.working).toBe(true);
    h.ctl.enqueue("and a short summary");
    expect(queue(h).map((q) => [q.text, q.canSendNow])).toEqual([["and a short summary", true]]);
    await first;
    await waitFor(
      "the queued message sent and answered",
      () => texts(h, "user").length === 2 && !h.ctl.model.meta.busy,
    );
    expect(texts(h, "user")).toEqual(["write a long essay", "and a short summary"]);
    expect(queue(h)).toEqual([]);
    // One "finished": after the last one, not between the two.
    expect(h.bg.turns).toHaveLength(1);
  });

  it("stays after Stop: it waits for you", async () => {
    const h = harness("slow");
    const first = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    h.ctl.enqueue("and a short summary");
    await h.ctl.stop();
    await first;
    await new Promise((r) => setTimeout(r, 100));
    expect(texts(h, "user")).toEqual(["write a long essay"]);
    expect(queue(h).map((q) => q.text)).toEqual(["and a short summary"]);
    // Idle now: "Send" sends it as a normal message.
    await h.ctl.sendQueuedNow(queue(h)[0]?.id ?? "");
    expect(texts(h, "user")).toEqual(["write a long essay", "and a short summary"]);
    expect(queue(h)).toEqual([]);
  });

  it("Send now: into the running reply, as its own bubble; Hermes's answer stays out", async () => {
    const h = harness("slow");
    const first = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    h.ctl.enqueue("keep it under 200 words");
    await h.ctl.sendQueuedNow(queue(h)[0]?.id ?? "");
    expect(queue(h)).toEqual([]);
    const steered = items(h).find((i) => i.kind === "user" && i.steered);
    expect(steered).toMatchObject({ text: "keep it under 200 words", turn: 1 });
    expect(prompts(h)).toHaveLength(2);
    expect(prompts(h)[1]).toContain("keep it under 200 words");
    // The rest of the reply lands BELOW the bubble.
    const n = items(h).length;
    await waitFor("more reply", () => items(h).length > n);
    const at = steered ? items(h).indexOf(steered) : -1;
    expect(
      items(h)
        .slice(at + 1)
        .some((i) => i.kind === "assistant"),
    ).toBe(true);
    expect(texts(h, "assistant").join("")).not.toContain("Redirected the active turn");
    await h.ctl.stop();
    await first;
  });

  it("a file waits for the reply: Send now does nothing", async () => {
    const h = harness("slow");
    const first = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    const file: Attachment = {
      id: "f1",
      kind: "file",
      label: "a.ts",
      block: { type: "resource_link", uri: "file:///a.ts", name: "a.ts" },
    };
    h.ctl.enqueue("look at this file", [file]);
    expect(queue(h)[0]).toMatchObject({
      canSendNow: false,
      chips: [{ kind: "file", label: "a.ts" }],
    });
    await h.ctl.sendQueuedNow(queue(h)[0]?.id ?? "");
    expect(queue(h)).toHaveLength(1);
    expect(prompts(h)).toHaveLength(1);
    await h.ctl.stop();
    await first;
  });

  it("leaving the chat hands queued messages back to the composer", async () => {
    const h = harness("slow");
    const first = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    h.ctl.enqueue("and a short summary");
    await h.ctl.newChat();
    expect(h.bg.returned).toEqual(["and a short summary"]);
    expect(queue(h)).toEqual([]);
    await h.ctl.shutdown();
    await first.catch(() => undefined);
  });
});

describe("the context pop-up's /context", () => {
  it("asks Hermes in the background: the report comes back, the chat shows nothing", async () => {
    const h = harness("stream");
    await h.ctl.send("hello");
    const before = h.ctl.model;
    const text = await h.ctl.contextReport();
    expect(text).toMatch(/^Conversation: 4 messages/);
    expect(text).toContain("Context usage: ~29,123 / 1,000,000 tokens");
    // Nothing new in the transcript, no new turn.
    expect(h.ctl.model.items).toEqual(before.items);
    expect(h.ctl.model.meta.turn).toBe(before.meta.turn);
    expect(h.ctl.model.meta.busy).toBe(false);
    const prompts = h.log().filter((l) => l.msg?.method === "session/prompt");
    expect(prompts.at(-1)?.msg?.params?.prompt).toEqual([{ type: "text", text: "/context" }]);
  });

  it("does not ask while Hermes is working (its reply would mix in)", async () => {
    const h = harness("slow");
    const turn = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    expect(await h.ctl.contextReport()).toBeUndefined();
    await h.ctl.stop();
    await turn;
  });

  it("does not start Hermes just to ask", async () => {
    const h = harness("stream");
    expect(await h.ctl.contextReport()).toBeUndefined();
    expect(h.pids).toEqual([]);
  });

  it("a message sent right after waits for the report and streams normally", async () => {
    const h = harness("stream");
    await h.ctl.send("hello");
    const report = h.ctl.contextReport();
    const sent = h.ctl.send("and again");
    expect(await report).toMatch(/^Conversation/);
    expect(await sent).toBe(true);
    // The second reply is in the chat, and the report is not.
    expect(texts(h, "assistant").join("\n")).not.toContain("Conversation:");
    expect(
      items(h)
        .filter((i) => i.kind === "user")
        .map((i) => i.kind === "user" && i.text),
    ).toEqual(["hello", "and again"]);
  });
});

describe("the composer's + (attachments)", () => {
  const FILE: Attachment = {
    id: "ctx~1",
    kind: "file",
    label: "auth.ts",
    detail: "src/auth.ts",
    block: { type: "resource_link", uri: "file:///c%3A/work/src/auth.ts", name: "src/auth.ts" },
  };
  const PROBLEMS: Attachment = {
    id: "ctx~2",
    kind: "problems",
    label: "Problems (1)",
    block: {
      type: "text",
      text: "[Problems reported by VS Code: 1 error, 0 warnings]\n- a.ts:1:1 error: x",
    },
  };
  const IMAGE: Attachment = {
    id: "ctx~3",
    kind: "image",
    label: "Pasted image",
    size: "461×398",
    block: { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
  };

  it("sends the text first, then each attachment's block, and shows chips on the bubble", async () => {
    const h = harness("stream");
    const sent = await h.ctl.send("fix these", [FILE, PROBLEMS, IMAGE]);
    expect(sent).toBe(true);
    const prompt = h.log().find((l) => l.msg?.method === "session/prompt");
    expect(prompt?.msg?.params?.prompt).toEqual([
      { type: "text", text: "fix these" },
      FILE.block,
      PROBLEMS.block,
      IMAGE.block,
    ]);
    expect(items(h)[0]).toEqual({
      kind: "user",
      id: expect.any(String),
      text: "fix these",
      turn: 1,
      // How long the reply took: its footer shows it (mock board 23).
      ms: expect.any(Number),
      attachments: [
        { kind: "file", label: "auth.ts" },
        { kind: "problems", label: "Problems (1)" },
        // Only an image keeps its id: the bubble asks the host for the picture.
        { kind: "image", label: "Pasted image", id: "ctx~3", size: "461×398" },
      ],
    });
    // Chips are small: the image data stays out of the model (and the webview).
    expect(JSON.stringify(h.ctl.model)).not.toContain("iVBORw0KGgo");
    expect(h.mirror()).toEqual(h.ctl.model);
    expect(h.ctl.acceptsImages()).toBe(true);
  });

  it("sends the file you are in as a text block, with an 'editor' chip on the bubble", async () => {
    const h = harness("stream");
    const editor: Attachment = {
      id: "editor~1",
      kind: "editor",
      label: "login.ts",
      sourceUri: "file:///c%3A/work/src/auth/login.ts",
      block: {
        type: "text",
        text: "[VS Code: the user is working in src/auth/login.ts, line 44.]",
      },
    };
    await h.ctl.send("why?", [editor]);
    const prompt = h.log().find((l) => l.msg?.method === "session/prompt");
    expect(prompt?.msg?.params?.prompt).toEqual([{ type: "text", text: "why?" }, editor.block]);
    expect(items(h)[0]).toMatchObject({ attachments: [{ kind: "editor", label: "login.ts" }] });
    // The bubble keeps no id for a non-image chip.
    expect(items(h)[0]).not.toMatchObject({ attachments: [{ id: expect.anything() }] });
  });

  it('a skill from the "/" menu: the note asks Hermes to load it; the bubble shows a skill chip', async () => {
    const h = harness("stream");
    await h.ctl.send("rewrite the email", [], ["humanizer"]);
    const prompt = h.log().find((l) => l.msg?.method === "session/prompt");
    expect(prompt?.msg?.params?.prompt).toEqual([
      {
        type: "text",
        text: '[The user invoked the "humanizer" skill from the editor. Load it first with skill_view and follow its instructions for this request.]\n\nrewrite the email',
      },
    ]);
    expect(items(h)[0]).toMatchObject({
      kind: "user",
      text: "rewrite the email",
      attachments: [{ kind: "skill", label: "humanizer" }],
    });
  });

  // A reported bug: a skill typed mid-text jumped to a chip on top, and a second
  // one was never offered. Now both stay in the text where typed.
  it("two skills typed in the text: one note names both; the text keeps them, no chips", async () => {
    const h = harness("stream");
    const text = "restyle the cards /emil-design-eng, maybe use /hubspot-module-builder";
    await h.ctl.send(text, [], ["emil-design-eng", "hubspot-module-builder"]);
    const prompt = h.log().find((l) => l.msg?.method === "session/prompt");
    expect(prompt?.msg?.params?.prompt).toEqual([
      {
        type: "text",
        text: `[The user invoked the "emil-design-eng" and "hubspot-module-builder" skills from the editor. Load each first with skill_view and follow their instructions for this request.]\n\n${text}`,
      },
    ]);
    expect(items(h)[0]).toMatchObject({ kind: "user", text });
    expect(items(h)[0]).not.toHaveProperty("attachments");
  });

  it("a plain message has one text block and no chips", async () => {
    const h = harness("stream");
    await h.ctl.send("hello");
    const prompt = h.log().find((l) => l.msg?.method === "session/prompt");
    expect(prompt?.msg?.params?.prompt).toEqual([{ type: "text", text: "hello" }]);
    expect(items(h)[0]).not.toHaveProperty("attachments");
  });

  it("reports a message stopped before it went out as not sent (the chips go back)", async () => {
    const h = harness("stream");
    const turn = h.ctl.send("never mind", [FILE]);
    await h.ctl.stop();
    expect(await turn).toBe(false);
    expect(items(h)[0]).toMatchObject({ notSent: true, attachments: [{ kind: "file" }] });
    expect(methods(h)).not.toContain("session/prompt");
  });

  it("refuses an empty message, even with attachments", async () => {
    const h = harness("stream");
    expect(await h.ctl.send("   ", [FILE])).toBe(false);
    expect(items(h)).toEqual([]);
  });
});

describe("model and mode switching (slice 3)", () => {
  it("offers Hermes's models and modes once the session exists", async () => {
    const h = harness("stream");
    h.ctl.viewVisible();
    await waitFor("ready", () => h.ctl.model.meta.connection.state === "ready");
    const m = h.ctl.model.meta;
    expect(m.modelId).toBe("anthropic:claude-opus-5-5");
    expect(m.model).toBe("claude-opus-5-5");
    expect(m.models?.map((c) => c.id)).toEqual([
      "anthropic:claude-opus-4-5-20251101",
      "anthropic:claude-opus-5-5",
      "openai-codex:gpt-6-astra",
    ]);
    expect(m.models?.[2]?.provider).toBe("ChatGPT or Codex Subscription");
    expect(m.mode).toBe("default");
    expect(m.modes?.map((x) => x.id)).toEqual(["default", "accept_edits", "dont_ask"]);
  });

  it("switches the model in the same session and keeps chatting in it", async () => {
    const h = harness("stream");
    await h.ctl.send("hello");
    const session = h.ctl.model.meta.sessionId;
    await h.ctl.setModel("openai-codex:gpt-6-astra");
    const m = h.ctl.model.meta;
    expect(m).toMatchObject({
      modelId: "openai-codex:gpt-6-astra",
      model: "gpt-6-astra",
      sessionId: session,
    });
    expect(m.switchingModel).toBeUndefined();
    expect(texts(h, "notice")).toEqual([
      "Switched to gpt-6-astra. The conversation continues with it.",
    ]);
    const call = h.log().find((l) => l.msg?.method === "session/set_model");
    expect(call?.msg?.params).toEqual({ sessionId: session, modelId: "openai-codex:gpt-6-astra" });

    await h.ctl.send("go on");
    const prompts = h.log().filter((l) => l.msg?.method === "session/prompt");
    expect(prompts.map((p) => p.msg?.params?.sessionId)).toEqual([session, session]);
    // Hermes remembers it: reopening the session reports the new model.
    await h.ctl.newChat();
    await h.ctl.openSaved(session as string);
    expect(h.ctl.model.meta.modelId).toBe("openai-codex:gpt-6-astra");
  });

  it("reports a model Hermes cannot serve and stays on the old one", async () => {
    const h = harness("stream");
    await h.ctl.send("hello");
    await h.ctl.setModel("nope:llama-9");
    const m = h.ctl.model.meta;
    expect(m.modelId).toBe("anthropic:claude-opus-5-5");
    expect(m.switchingModel).toBeUndefined();
    expect(texts(h, "notice")[0]).toMatch(/^Could not switch to nope:llama-9: .*not available/);
  });

  it("refuses to switch mid-turn, without asking Hermes", async () => {
    const h = harness("slow");
    const turn = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    await h.ctl.setModel("openai-codex:gpt-6-astra");
    expect(texts(h, "notice")).toEqual(["Switch models when Hermes is idle: press Stop first."]);
    expect(methods(h)).not.toContain("session/set_model");
    await h.ctl.stop();
    await turn;
  });

  it("a usage limit offers another model; continuing switches and sends the message again", async () => {
    const h = harness("limit");
    await h.ctl.send("fix the login redirect");
    const session = h.ctl.model.meta.sessionId;
    expect(h.ctl.model.meta.limit).toEqual({
      kind: "limit",
      provider: "Anthropic",
      resets: "14:10 (in 2h 05m)",
    });
    // Hermes's own explanation stays in the chat as its reply.
    expect(texts(h, "assistant")[0]).toMatch(/^Anthropic rate-limited every one of 3 attempts/);

    await h.ctl.continueWith("openai-codex:gpt-6-astra");
    const m = h.ctl.model.meta;
    expect(m.limit).toBeUndefined();
    expect(m).toMatchObject({
      modelId: "openai-codex:gpt-6-astra",
      sessionId: session,
      busy: false,
    });
    const prompts = h.log().filter((l) => l.msg?.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts.map((p) => p.msg?.params?.sessionId)).toEqual([session, session]);
    expect(texts(h, "user")).toEqual(["fix the login redirect", "fix the login redirect"]);
    // The resent message got a real answer this time.
    expect(texts(h, "assistant").at(-1)).not.toMatch(/rate-limited/);
  });

  it("a new message or Dismiss clears the limit banner", async () => {
    const h = harness("limit");
    await h.ctl.send("first");
    expect(h.ctl.model.meta.limit).toBeDefined();
    h.ctl.dismissLimit();
    expect(h.ctl.model.meta.limit).toBeUndefined();
    await h.ctl.send("second");
    expect(h.ctl.model.meta.limit).toBeDefined(); // still Anthropic: limited again
    const turn = h.ctl.send("third");
    await waitFor("busy", () => h.ctl.model.meta.busy);
    expect(h.ctl.model.meta.limit).toBeUndefined();
    await turn;
  });

  it("switches the edit-approval mode", async () => {
    const h = harness("stream");
    await h.ctl.send("hello");
    await h.ctl.setMode("accept_edits");
    expect(h.ctl.model.meta.mode).toBe("accept_edits");
    const call = h.log().find((l) => l.msg?.method === "session/set_mode");
    expect(call?.msg?.params).toMatchObject({ modeId: "accept_edits" });
    expect(texts(h, "notice")).toEqual([]);
  });
});

describe("permissions", () => {
  it("answers a request with id 0 in Hermes's nested shape", async () => {
    const h = harness("permission");
    await h.ctl.send("edit it");
    const reply = h.log().find((l) => l.msg && l.msg.id === 0 && !l.msg.method);
    expect(reply?.msg?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(h.ctl.model.meta.busy).toBe(false);
  });

  const card = (h: Harness) => items(h).find((i) => i.kind === "permission");

  it("shows the request as a card in the chat and records the answer on it", async () => {
    const h = harness("permission");
    await h.ctl.send("edit it");
    const c = card(h);
    expect(c).toMatchObject({
      kind: "permission",
      action: "edit",
      heading: "Edit",
      target: "src/a.ts",
      state: "answered",
      answer: { label: "Allow edit", allowed: true },
    });
    // Deny first, whatever order Hermes sent.
    expect(c?.kind === "permission" && c.options.map((o) => o.optionId)).toEqual([
      "deny",
      "allow_once",
    ]);
    expect(c?.kind === "permission" && c.diff?.lines.map((l) => [l.kind, l.text])).toEqual([
      ["del", "export const a = 1;"],
      ["add", "export const a = 2;"],
    ]);
    // "Open diff" has the full texts.
    expect(h.ctl.diffFor(c?.id ?? "")).toEqual({
      path: "src/a.ts",
      oldText: "export const a = 1;\n",
      newText: "export const a = 2;\n",
    });
    expect(h.mirror()).toEqual(h.ctl.model);
  });

  it("Deny answers with the reject option", async () => {
    const h = harness("permission", { answer: () => "deny" });
    await h.ctl.send("edit it");
    const reply = h.log().find((l) => l.msg && l.msg.id === 0 && !l.msg.method);
    expect(reply?.msg?.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(card(h)).toMatchObject({ state: "answered", answer: { label: "Deny", allowed: false } });
  });

  it("ignores an option Hermes did not offer, and keeps waiting", async () => {
    const h = harness("permission", { answer: () => "hold" });
    const turn = h.ctl.send("edit it");
    await waitFor("card shown", () => h.asked.length === 1);
    expect(h.asked[0]?.answer("allow_everything_forever")).toBe(false);
    expect(card(h)).toMatchObject({ state: "pending" });
    expect(h.asked[0]?.answer("allow_once")).toBe(true);
    await turn;
    expect(card(h)).toMatchObject({ state: "answered" });
  });

  // Hermes gives up after approvals.timeout and closes the synthetic id with a
  // failed update; the card must say so, and a later click must not count.
  it("marks a card Hermes stopped waiting for as expired; a late click does nothing", async () => {
    const h = harness("permission", {
      answer: () => "hold",
      env: { FAKE_AGENT_PERMISSION_TIMEOUT_MS: "200" },
    });
    const turn = h.ctl.send("edit it");
    await waitFor("card shown", () => h.asked.length === 1);
    await turn; // Hermes timed out, the turn finished without our answer
    expect(card(h)).toMatchObject({ state: "expired" });
    expect(h.asked[0]?.answer("allow_once")).toBe(false);
    expect(card(h)).toMatchObject({ state: "expired" });
  });

  it("Stop while a card waits cancels it", async () => {
    const h = harness("permission", { answer: () => "hold" });
    const turn = h.ctl.send("edit it");
    await waitFor("card shown", () => h.asked.length === 1);
    await h.ctl.stop();
    await turn;
    expect(card(h)).toMatchObject({ state: "cancelled" });
    const reply = h.log().find((l) => l.msg && l.msg.id === 0 && !l.msg.method);
    expect(reply?.msg?.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("a command card shows the exact command and why Hermes flagged it", async () => {
    const h = harness("permission", { env: { FAKE_AGENT_PERMISSION_IDS: "perm-check-1" } });
    await h.ctl.send("clean up");
    expect(card(h)).toMatchObject({
      action: "command",
      heading: "Run a command",
      target: "rm -rf build",
      detail: "recursive delete",
    });
    const c = card(h);
    expect(c?.kind === "permission" && c.options.map((o) => o.kind)).toEqual([
      "reject_once",
      "allow_once",
      "allow_always",
      "allow_always",
      "reject_always",
    ]);
  });
});

describe("Stop", () => {
  it("withdraws a message stopped before Hermes was ready — it is never sent", async () => {
    const h = harness("stream");
    const turn = h.ctl.send("never mind");
    await h.ctl.stop();
    await turn;
    expect(items(h)[0]).toMatchObject({ kind: "user", notSent: true });
    expect(h.ctl.model.meta.busy).toBe(false);
    await waitFor("session ready", () => h.ctl.model.meta.connection.state === "ready");
    expect(methods(h)).not.toContain("session/prompt");
  });

  it("cancels a running turn and warns that the request carries over", async () => {
    const h = harness("slow");
    const turn = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    await h.ctl.stop();
    await turn;
    expect(methods(h)).toContain("session/cancel");
    expect(texts(h, "notice")).toContain(STOPPED_NOTICE);
    expect(h.ctl.model.meta.busy).toBe(false);
  });
});

describe("New chat and Restart", () => {
  // v1 bug: the old turn kept running and its chunks landed in the new chat.
  // Now it keeps running ON PURPOSE (in the background), still out of the new chat.
  it("leaves the old turn working in the background and keeps its output out of the new chat", async () => {
    const h = harness("slow", { env: { FAKE_AGENT_CHUNK_MS: "30" } });
    const turn = h.ctl.send("long task");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    const first = h.ctl.model.meta.sessionId;
    await h.ctl.newChat();
    expect(items(h)).toEqual([]);
    expect(h.ctl.model.meta.busy).toBe(false);
    expect(h.ctl.model.meta.sessionId).not.toBe(first);
    expect(h.bg.lists.at(-1)).toEqual([{ id: first, title: "long task", state: "working" }]);
    await turn; // it finishes in the background
    expect(items(h)).toEqual([]);
    const m = methods(h);
    expect(m).not.toContain("session/cancel");
    expect(m.filter((x) => x === "session/new")).toHaveLength(2);
    expect(h.bg.lists.at(-1)).toEqual([]);
    expect(h.bg.done).toEqual([
      { session: { id: first, title: "long task", state: "working" }, outcome: "done" },
    ]);
  });

  it("two quick Restarts leave exactly one live Hermes", async () => {
    const h = harness("stream");
    await h.ctl.send("hi");
    await Promise.all([h.ctl.restart(), h.ctl.restart()]);
    await waitFor("ready", () => h.ctl.model.meta.connection.state === "ready");
    await waitFor("old processes gone", () => h.pids.slice(0, -1).every((p) => !alive(p)), 8000);
    const live = h.pids.filter(alive);
    expect(live).toHaveLength(1);
  });
});

// The fake starts with one persisted session bound to the folder it runs in.
const SEEDED = "0b6f3a52-5c1e-4d7a-9f10-2c8e4b7d9a31";
const SEEDED_REPLY = [
  "I'll look at src/auth.ts first.",
  "Fixed: the redirect now keeps `returnTo`.",
];

describe("rename and delete from the Sessions pop-up", () => {
  it("only sessions this folder's list showed may change", async () => {
    const h = harness("stream");
    expect(h.ctl.sessionChangeBlocked(SEEDED, "rename")).toMatch(/not in this folder/);
    await h.ctl.listSessions();
    expect(h.ctl.sessionChangeBlocked(SEEDED, "rename")).toBeUndefined();
    expect(h.ctl.sessionChangeBlocked(SEEDED, "delete")).toBeUndefined();
    expect(h.ctl.sessionChangeBlocked("someone-elses-id", "delete")).toMatch(/not in this folder/);
  });

  it("a deleted session is not listed again by this Hermes process", async () => {
    const h = harness("stream");
    await h.ctl.listSessions();
    h.ctl.forgetSession(SEEDED);
    expect((await h.ctl.listSessions()).items.map((s) => s.id)).not.toContain(SEEDED);
    expect(h.ctl.sessionTitle(SEEDED)).toBeUndefined();
    expect(h.ctl.sessionChangeBlocked(SEEDED, "delete")).toMatch(/not in this folder/);
  });

  it("deleting the chat on screen moves to a new chat first", async () => {
    const h = harness("stream");
    await h.ctl.send("hello");
    const id = h.ctl.model.meta.sessionId as string;
    await h.ctl.listSessions();
    expect(h.ctl.sessionChangeBlocked(id, "delete")).toBeUndefined();
    await h.ctl.leaveSession(id);
    expect(h.ctl.model.meta.sessionId).not.toBe(id);
    expect(h.ctl.model.items).toEqual([]);
  });

  it("the chat on screen cannot be deleted while Hermes works in it", async () => {
    const h = harness("slow");
    const turn = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    await h.ctl.listSessions();
    const id = h.ctl.model.meta.sessionId as string;
    expect(h.ctl.sessionChangeBlocked(id, "delete")).toMatch(/working in it/);
    // In its first reply Hermes does not list it yet, so the pop-up cannot offer it.
    expect(h.ctl.sessionChangeBlocked(id, "rename")).toMatch(/not in this folder/);
    await h.ctl.stop();
    await turn;
  });

  it("a rename shows in the header at once", async () => {
    const h = harness("stream");
    await h.ctl.send("hello");
    const id = h.ctl.model.meta.sessionId as string;
    h.ctl.sessionRenamed(id, "My own name");
    expect(h.ctl.model.meta.title).toBe("My own name");
    expect(h.ctl.sessionTitle(id)).toBe("My own name");
    expect(h.mirror().meta.title).toBe("My own name");
  });
});

describe("saved sessions (slice 2)", () => {
  it("lists this folder's sessions, newest first, with Hermes's titles", async () => {
    const h = harness("stream");
    const first = await h.ctl.listSessions();
    expect(first.items).toEqual([
      {
        id: SEEDED,
        title: "Fix the login redirect",
        updatedAt: "2026-09-20T11:17:17.940042+00:00",
      },
    ]);
    expect(first.nextCursor).toBeUndefined();
    // A session appears once it has history, on top.
    await h.ctl.send("hello");
    const current = h.ctl.model.meta.sessionId;
    expect(current).toBeTruthy();
    const after = await h.ctl.listSessions();
    expect(after.items.map((s) => s.id)).toEqual([current, SEEDED]);
    const listCall = h.log().find((l) => l.msg?.method === "session/list");
    expect(listCall?.msg?.params?.cwd).toBeTruthy();
  });

  it("reopens a session: the replay rebuilds its turns, then chatting continues in it", async () => {
    const h = harness("stream");
    await h.ctl.listSessions(); // as the Sessions view does: it knows the title from here
    await h.ctl.openSaved(SEEDED);
    const m = h.ctl.model;
    expect(m.meta).toMatchObject({
      connection: { state: "ready" },
      sessionId: SEEDED,
      title: "Fix the login redirect",
      turn: 1,
    });
    expect(m.meta.model).toBeTruthy();
    expect(items(h).map((i) => [i.kind, i.turn])).toEqual([
      ["user", 1],
      ["thought", 1],
      ["assistant", 1],
      ["tool", 1],
      ["assistant", 1],
    ]);
    expect(texts(h, "assistant")).toEqual(SEEDED_REPLY);
    // The replayed step keeps what it showed live: its result and its file.
    expect(items(h)[3]).toMatchObject({
      kind: "tool",
      status: "completed",
      locations: [{ path: "src/auth.ts" }],
    });
    const replayed = items(h)[3];
    expect(replayed?.kind === "tool" && replayed.output).toMatch(/^Read src\/auth\.ts/);
    // What the webview would see after the JSON bridge is the same model.
    expect(h.mirror()).toEqual(h.ctl.model);

    await h.ctl.send("and add a test");
    const prompt = h.log().find((l) => l.msg?.method === "session/prompt");
    expect(prompt?.msg?.params?.sessionId).toBe(SEEDED);
    expect(h.ctl.model.meta.turn).toBe(2);
    expect(items(h).at(-4)).toMatchObject({ kind: "user", text: "and add a test", turn: 2 });
  });

  it("an id Hermes no longer has: says so and continues as a fresh session", async () => {
    const h = harness("stream");
    await h.ctl.openSaved("11111111-2222-3333-4444-555555555555");
    const m = h.ctl.model;
    expect(texts(h, "notice")).toEqual(["Hermes no longer has that session. This is a new chat."]);
    expect(m.meta.connection).toEqual({ state: "ready" });
    expect(m.meta.sessionId).toBeTruthy();
    expect(m.meta.sessionId).not.toBe("11111111-2222-3333-4444-555555555555");
  });

  it("opening a session while Hermes works leaves the turn working and its output out", async () => {
    const h = harness("slow", { env: { FAKE_AGENT_CHUNK_MS: "30" } });
    const turn = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    await h.ctl.openSaved(SEEDED);
    expect(texts(h, "assistant")).toEqual(SEEDED_REPLY);
    expect(h.ctl.model.meta).toMatchObject({ busy: false, sessionId: SEEDED });
    await turn;
    await new Promise((r) => setTimeout(r, 100));
    expect(methods(h)).not.toContain("session/cancel");
    expect(texts(h, "assistant")).toEqual(SEEDED_REPLY);
    expect(texts(h, "notice")).toEqual([]);
    expect(h.bg.done.map((d) => d.outcome)).toEqual(["done"]);
  });

  it("opening the session that is already open does nothing", async () => {
    const h = harness("stream");
    await h.ctl.openSaved(SEEDED);
    await h.ctl.openSaved(SEEDED);
    expect(methods(h).filter((x) => x === "session/load")).toHaveLength(1);
    expect(texts(h, "assistant")).toEqual(SEEDED_REPLY);
  });

  it("New chat leaves the saved session and marks the new one", async () => {
    const h = harness("stream");
    await h.ctl.openSaved(SEEDED);
    await h.ctl.newChat();
    expect(items(h)).toEqual([]);
    expect(h.ctl.model.meta.sessionId).toBeTruthy();
    expect(h.ctl.model.meta.sessionId).not.toBe(SEEDED);
    expect(h.ctl.model.meta.title).toBeUndefined();
  });
});

describe("chats working in the background", () => {
  // Hermes saves a turn's history only when the turn ends (acp_adapter/
  // server.py:952), so a session/load of a chat that is still working would
  // replay it WITHOUT the running turn: going back must not reload.
  it("going back shows what it did meanwhile, without a reload, and it keeps streaming there", async () => {
    const h = harness("slow", { env: { FAKE_AGENT_CHUNK_MS: "40" } });
    const turn = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    const essay = h.ctl.model.meta.sessionId as string;
    const before = texts(h, "assistant").join("").length;
    await h.ctl.openSaved(SEEDED);
    await new Promise((r) => setTimeout(r, 300)); // it works on meanwhile
    await h.ctl.openSaved(essay);
    expect(methods(h).filter((m) => m === "session/load")).toHaveLength(1); // SEEDED's only
    expect(h.ctl.model.meta).toMatchObject({ busy: true, sessionId: essay });
    expect(texts(h, "user")).toEqual(["write a long essay"]);
    expect(texts(h, "assistant").join("").length).toBeGreaterThan(before);
    expect(h.bg.lists.at(-1)).toEqual([]);
    await turn;
    expect(h.ctl.model.meta.busy).toBe(false);
    expect(h.bg.done).toEqual([]); // it finished on screen: no notice
    expect(methods(h)).not.toContain("session/cancel");
    expect(h.mirror()).toEqual(h.ctl.model);
  });

  it("Stop works on a chat you went back to", async () => {
    const h = harness("slow", { env: { FAKE_AGENT_CHUNK_MS: "40" } });
    const turn = h.ctl.send("write a long essay");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    const essay = h.ctl.model.meta.sessionId as string;
    await h.ctl.newChat();
    await h.ctl.openSaved(essay);
    await h.ctl.stop();
    await turn;
    expect(methods(h)).toContain("session/cancel");
    expect(texts(h, "notice")).toContain(STOPPED_NOTICE);
    expect(h.ctl.model.meta.busy).toBe(false);
  });

  it("an approval in a background chat waits for you: a notice, then the card when you go back", async () => {
    const h = harness("permission", { env: { FAKE_AGENT_CHUNK_MS: "150" }, answer: () => "hold" });
    const turn = h.ctl.send("edit the file");
    await waitFor("thinking", () => items(h).some((i) => i.kind === "thought"));
    const s = h.ctl.model.meta.sessionId as string;
    await h.ctl.newChat();
    await waitFor("the background approval", () => h.bg.asks.length === 1);
    // Never answered on your behalf, and not a card in the chat on screen.
    expect(h.bg.foregroundAsks).toBe(0);
    expect(items(h).some((i) => i.kind === "permission")).toBe(false);
    expect(h.bg.asks[0]?.session).toMatchObject({ id: s, state: "waiting" });
    expect(h.bg.lists.at(-1)).toEqual([{ id: s, title: "edit the file", state: "waiting" }]);
    const replies = () => h.log().filter((l) => l.msg?.id !== undefined && l.msg?.result);
    expect(replies().some((l) => JSON.stringify(l.msg?.result).includes("outcome"))).toBe(false);

    await h.ctl.openSaved(s);
    const card = items(h).find((i) => i.kind === "permission");
    expect(card).toMatchObject({ id: h.bg.asks[0]?.itemId, state: "pending" });
    expect(h.ctl.answerPermission(card?.id ?? "", "allow_once")).toBe(true);
    await turn;
    expect(items(h).find((i) => i.kind === "permission")).toMatchObject({ state: "answered" });
    const answer = replies().find((l) => JSON.stringify(l.msg?.result).includes("outcome"));
    expect(JSON.stringify(answer?.msg?.result)).toContain("allow_once");
  });

  it("a brand-new chat still working is listed, even before Hermes lists it", async () => {
    const h = harness("slow", { env: { FAKE_AGENT_CHUNK_MS: "40" } });
    const turn = h.ctl.send("first message");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    const s = h.ctl.model.meta.sessionId as string;
    await h.ctl.openSaved(SEEDED);
    // Hermes lists a session only once a turn of it has ended.
    expect((await h.ctl.listSessions()).items.map((x) => x.id)).toEqual([SEEDED]);
    expect(h.ctl.backgroundSessions()).toEqual([
      { id: s, title: "first message", state: "working" },
    ]);
    await turn;
  });

  it("Restart stops the chats working in the background too, and says so", async () => {
    const h = harness("slow", { env: { FAKE_AGENT_CHUNK_MS: "40" } });
    const turn = h.ctl.send("long task");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    await h.ctl.newChat();
    await h.ctl.restart();
    await turn;
    expect(h.ctl.backgroundSessions()).toEqual([]);
    expect(h.bg.lists.at(-1)).toEqual([]);
    expect(h.bg.done).toEqual([]);
    expect(texts(h, "notice")).toEqual([
      "Restarted Hermes — this is a new session. The chat working in the background stopped too.",
    ]);
  });
});

describe("failures", () => {
  it("ends the turn on a rejected prompt and shows Hermes's details", async () => {
    const h = harness("reject");
    await h.ctl.send("save it");
    expect(texts(h, "notice").join("\n")).toContain("save_session failed");
    expect(h.ctl.model.meta.busy).toBe(false);
    // the tool left open by the failed turn is closed, not spinning forever
    expect(items(h).find((i) => i.kind === "tool")).toMatchObject({ status: "failed" });
  });

  it("treats refusal as a lost session and starts a new one next time", async () => {
    const h = harness("refusal");
    await h.ctl.send("hi");
    expect(texts(h, "notice").join("\n")).toMatch(/no longer has this session/);
    await h.ctl.send("again");
    expect(methods(h).filter((x) => x === "session/new")).toHaveLength(2);
  });

  it("marks a crash, ends the turn, and recovers on the next send", async () => {
    const h = harness("crash");
    await h.ctl.send("go");
    expect(h.ctl.model.meta.connection.state).toBe("stopped");
    expect(h.ctl.model.meta.busy).toBe(false);
    // The notice names the exit code, not the SDK's "connection closed".
    expect(texts(h, "notice").join("\n")).toMatch(/stopped unexpectedly \(exit code 3\)/);
    await h.ctl.send("again"); // crashes again, but it did start a fresh process
    expect(new Set(h.log().map((l) => l.pid)).size).toBe(2);
  });

  it("stops auto-restarting after three crashes in a minute", async () => {
    const h = harness("crash");
    for (let i = 0; i < 3; i++) await h.ctl.send(`go ${i}`);
    await h.ctl.send("fourth");
    expect(new Set(h.log().map((l) => l.pid)).size).toBe(3);
    expect(texts(h, "notice").join("\n")).toMatch(/press restart/i);
  });

  it("shows Setup needed when Hermes has no provider, and ignores sends", async () => {
    const h = harness("noProvider");
    h.ctl.viewVisible();
    await waitFor("setup state", () => h.ctl.model.meta.connection.state === "setupNeeded");
    await h.ctl.send("hi");
    expect(items(h)).toEqual([]);
  });

  it("times out a Hermes that never answers initialize", async () => {
    const h = harness("hangInit", { client: { initializeTimeoutMs: 400 } });
    await h.ctl.send("hi");
    expect(h.ctl.model.meta.connection.state).toBe("error");
    expect(items(h)[0]).toMatchObject({ kind: "user", notSent: true });
  });
});

describe("shutdown", () => {
  // v1 bug: an un-awaited cancel was dropped by the following stdin.end().
  it("delivers session/cancel before closing Hermes's input", async () => {
    const h = harness("slow");
    const turn = h.ctl.send("long task");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    await h.ctl.shutdown();
    await turn;
    const log = h.log();
    const cancel = log.find((l) => l.msg?.method === "session/cancel");
    const eof = log.find((l) => l.event === "eof");
    expect(cancel).toBeDefined();
    expect(eof).toBeDefined();
    expect((cancel as LogLine).seq).toBeLessThan((eof as LogLine).seq);
    await waitFor("exited", () => h.pids.every((p) => !alive(p)), 3000);
  });

  it("kills a Hermes that ignores EOF, inside VS Code's 5 s budget", async () => {
    const h = harness("ignoreEof");
    await h.ctl.send("hi");
    const t0 = Date.now();
    await h.ctl.shutdown();
    expect(Date.now() - t0).toBeLessThan(5000);
    await waitFor("killed", () => h.pids.every((p) => !alive(p)), 2000);
  });
});

// Regression tests for the slice-1 code review (each reproduced a real bug).
describe("code review regressions", () => {
  // H1: VS Code disposes the output channel as soon as deactivate() awaits;
  // a throwing logger used to abort shutdown before stdin.end() and the kill.
  it("finishes shutdown even when the log starts throwing mid-way", async () => {
    const h = harness("slow");
    const turn = h.ctl.send("long task");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    const done = h.ctl.shutdown();
    h.breakLog(); // what VS Code does right after calling deactivate()
    await expect(done).resolves.toBeUndefined();
    await turn;
    expect(h.log().some((l) => l.event === "eof")).toBe(true);
    await waitFor("exited", () => h.pids.every((p) => !alive(p)), 3000);
  });

  // H2: a turn waiting for Hermes to start used to send its prompt before the
  // queued New chat / Restart ran.
  it("New chat while Hermes is starting withdraws the message — never sent", async () => {
    const h = harness("slow");
    const turn = h.ctl.send("rm -rf the build directory please");
    await h.ctl.newChat();
    await turn;
    await waitFor("ready", () => h.ctl.model.meta.connection.state === "ready");
    expect(methods(h)).not.toContain("session/prompt");
    expect(items(h)).toEqual([]);
  });

  it("Restart while Hermes is starting withdraws the message, with no false notice", async () => {
    const h = harness("slow");
    const turn = h.ctl.send("rm -rf the build directory please");
    await h.ctl.restart();
    await turn;
    await waitFor("ready", () => h.ctl.model.meta.connection.state === "ready");
    expect(methods(h)).not.toContain("session/prompt");
    expect(items(h)[0]).toMatchObject({ kind: "user", notSent: true });
    expect(texts(h, "notice")).not.toContain(STOPPED_NOTICE);
  });

  // H3/WV-1: clearing with `undefined` vanished in postMessage's JSON.
  it("keeps the webview's JSON-bridged copy identical to the host model", async () => {
    const h = harness("stream");
    await h.ctl.send("hello");
    await waitFor("late title", () => h.ctl.model.meta.title === "Fixture Title");
    await h.ctl.newChat();
    expect(h.ctl.model.meta.title).toBeUndefined();
    expect(h.mirror().meta.title).toBeUndefined();
    expect(JSON.parse(JSON.stringify(h.mirror()))).toEqual(JSON.parse(JSON.stringify(h.ctl.model)));
  });

  // H4: shutdown used to ignore a client still being retired by Restart.
  it("shutdown waits for a Hermes that Restart is still stopping", async () => {
    const h = harness("ignoreEof");
    await h.ctl.send("hi");
    const old = h.pids[0] as number;
    void h.ctl.restart();
    await new Promise((r) => setTimeout(r, 100));
    await h.ctl.shutdown();
    await waitFor("old Hermes killed", () => !alive(old), 1500);
  });

  // H5: Restart mid-turn used to promise a carry-over that cannot happen.
  it("Restart mid-turn shows only the restart notice", async () => {
    const h = harness("slow");
    const turn = h.ctl.send("long task");
    await waitFor("streaming", () => texts(h, "assistant").join("").length > 0);
    await h.ctl.restart();
    await turn;
    expect(texts(h, "notice")).toEqual(["Restarted Hermes — this is a new session."]);
  });

  // F1: Stop during a /queue'd prompt's nested turn: Hermes still carries the
  // stopped text over, though the outer prompt resolves end_turn.
  it("warns about the carry-over when Stop hits a queued prompt", async () => {
    const h = harness("slow");
    const turn = h.ctl.send("/queue delete the build folder and redeploy");
    await waitFor("queued turn streaming", () =>
      texts(h, "assistant").some((t) => t.startsWith("Part 1")),
    );
    await h.ctl.stop();
    await turn;
    const notice = items(h).find((i) => i.kind === "notice" && i.text === STOPPED_NOTICE);
    expect(notice).toMatchObject({ action: "newChat" });
  });

  it("does not warn when a queued prompt finishes normally", async () => {
    const h = harness("stream");
    await h.ctl.send("/queue say hi");
    expect(texts(h, "notice")).toEqual([]);
  });

  // H7: a spawn that never started (missing cwd) used to count as a crash.
  it("does not count a failed spawn as a crash", async () => {
    const h = harness("stream", { folder: join(tmpdir(), "hs-does-not-exist-9f3a") });
    for (let i = 0; i < 3; i++) await h.ctl.send(`try ${i}`);
    const notices = texts(h, "notice").join("\n");
    expect(notices).not.toMatch(/stopped unexpectedly|stopped repeatedly/i);
    expect(h.ctl.model.meta.connection.state).toBe("error");
  });

  // F2: "/model qwen3:32b" used to show "32b".
  it("shows a /model name with a colon verbatim", async () => {
    const h = harness("slashModel");
    await h.ctl.send("/model qwen3:32b");
    expect(h.ctl.model.meta.model).toBe("qwen3:32b");
  });

  // F3: a new session used to inherit the old session's header.
  it("clears the old session's model, usage and title when Restart lands on setup", async () => {
    let scenario = "stream";
    const h = harness(() => scenario);
    await h.ctl.send("hello");
    await waitFor("late title", () => h.ctl.model.meta.title === "Fixture Title");
    scenario = "noProvider";
    await h.ctl.restart();
    const m = h.ctl.model.meta;
    expect(m.connection.state).toBe("setupNeeded");
    expect([m.model, m.usage, m.title]).toEqual([undefined, undefined, undefined]);
    expect(h.mirror().meta.title).toBeUndefined();
  });

  // WV-5: the refusal notice offers New chat through the field, not the wording.
  it("offers New chat on the refusal notice", async () => {
    const h = harness("refusal");
    await h.ctl.send("hi");
    const n = items(h).find((i) => i.kind === "notice");
    expect(n).toMatchObject({ level: "error", action: "newChat" });
  });
});
