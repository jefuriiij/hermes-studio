// The REAL ChatController + HermesClient driving the REAL hermes.exe acp, in an
// isolated Hermes home whose only model is a fake OpenAI-compatible server on
// 127.0.0.1. Zero quota by construction — and every session is checked to be
// bound to the fake provider BEFORE any prompt can go out.
//
// Opt-in: HERMES_STUDIO_REAL=1, Windows only (see harness.ts). Never run during
// a `hermes update` (the sandbox junctions Hermes's real installs dir).

import { afterEach, describe, expect, it } from "vitest";

import type { ChatItem } from "../../src/shared/chat";
import { ChatController, STOPPED_NOTICE } from "../../src/host/chatController";
import { HermesClient } from "../../src/host/hermesClient";
import { parseContextReport } from "../../src/logic/contextInfo";
import { runHermes } from "../../src/host/accountUsage";
import { SessionActions } from "../../src/host/sessionActions";
import type { SessionActionResult } from "../../src/shared/protocol";
import {
  alivePids,
  assertFakeProvider,
  createHermesSandbox,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_TITLE,
  descendantPids,
  type FakeModel,
  type HermesSandbox,
  type FakeModelOptions,
  killTree,
  RUN_REAL,
  startFakeModel,
} from "./harness";

interface Rig {
  ctl: ChatController;
  pids: number[];
  stderr: string[];
  fake: FakeModel;
  /** Chats that finished while working in the background. */
  bgDone: { id: string; outcome: string }[];
  box: HermesSandbox;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch (e) {
      console.error("cleanup failed:", e);
    }
  }
});

async function rig(model: FakeModelOptions = {}): Promise<Rig> {
  const fake = await startFakeModel(model);
  cleanups.push(() => fake.close());
  const box = createHermesSandbox({
    fakeModel: fake,
    parentDir: process.env.HERMES_STUDIO_REAL_TMPDIR,
  });
  const pids: number[] = [];
  const stderr: string[] = [];
  const bgDone: Rig["bgDone"] = [];

  const ctl = new ChatController({
    folder: () => ({ path: box.cwd, name: "work" }),
    launch: () => ({ ok: true, command: box.command, args: box.args, env: box.env }),
    createClient: (o) => {
      const c = new HermesClient(o);
      const newSession = c.newSession.bind(c);
      // Safety abort: if this session is not bound to the fake provider,
      // session creation fails, so no prompt can ever reach a paid model.
      c.newSession = async (cwd) => {
        const res = await newSession(cwd);
        assertFakeProvider(res);
        return res;
      };
      // The same guard for a reopened session. An unknown id gets `{}` — no
      // models, nothing to check, and the controller treats it as gone.
      const loadSession = c.loadSession.bind(c);
      c.loadSession = async (cwd, id) => {
        const res = await loadSession(cwd, id);
        if (res?.models) assertFakeProvider(res);
        return res;
      };
      const start = c.start.bind(c);
      c.start = async () => {
        const r = await start();
        if (c.pid !== undefined) pids.push(c.pid);
        return r;
      };
      return c;
    },
    trace: () => false,
    log: () => undefined,
    onStderrLine: (l) => stderr.push(l),
    // No test here approves anything: withdraw every card (Hermes: deny).
    onPermission: (item) => setImmediate(() => ctl.answerPermission(item.id)),
    onBackgroundDone: (s, outcome) => bgDone.push({ id: s.id, outcome }),
    now: () => Date.now(),
  });

  cleanups.push(async () => {
    await ctl.shutdown();
    for (const pid of pids) killTree(pid); // belt and braces; no-op when gone
    box.dispose(); // unlinks the junction first, then deletes
  });
  return { ctl, pids, stderr, fake, bgDone, box };
}

async function waitFor(what: string, cond: () => boolean, ms = 60_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const items = (r: Rig): ChatItem[] => r.ctl.model.items;
const text = (r: Rig, kind: ChatItem["kind"]) =>
  items(r)
    .filter((i) => i.kind === kind)
    .map((i) => ("text" in i ? i.text : ""))
    .join("");

/** A long, slow reply so there is time to Stop / New chat / shut down mid-turn. */
const SLOW: FakeModelOptions = {
  chunkDelayMs: 250,
  content: Array.from({ length: 60 }, (_, i) => `word${i} `),
};
/** About 5 s: long enough to leave a chat mid-reply, short enough to wait for. */
const MEDIUM: FakeModelOptions = {
  chunkDelayMs: 120,
  content: Array.from({ length: 40 }, (_, i) => `word${i} `),
};
/** No trailing space: Hermes's replay trims the stored reply. */
const MEDIUM_LAST = "word39";

describe.skipIf(!RUN_REAL)("real Hermes, driven by the real controller (zero quota)", () => {
  it("runs a full turn: thought + answer as separate items, usage, late title", async () => {
    const r = await rig();
    r.ctl.viewVisible();
    await waitFor("session ready", () => r.ctl.model.meta.connection.state === "ready");
    expect(r.ctl.model.meta.model).toBe("fixture-model");

    await r.ctl.send("Reply with a short greeting; do not use tools.");
    const kinds = items(r).map((i) => i.kind);
    expect(kinds).toEqual(["user", "thought", "assistant"]);
    expect(new Set(items(r).map((i) => i.id)).size).toBe(items(r).length);
    expect(text(r, "assistant")).toContain("Hello");
    expect(r.ctl.model.meta.busy).toBe(false);
    expect(r.ctl.model.meta.usage?.size).toBe(DEFAULT_CONTEXT_LENGTH);
    await waitFor("auto-title", () => r.ctl.model.meta.title === DEFAULT_TITLE, 15_000);
  });

  it("renames and deletes sessions with `hermes sessions …`; a deleted one stays gone", async () => {
    const r = await rig();
    const results: SessionActionResult[] = [];
    const actions = new SessionActions(
      r.ctl,
      () => (args) => runHermes(r.box.command, r.box.env, args),
      (x) => results.push(x),
      () => undefined,
      () => undefined,
    );
    const ids = async () => (await r.ctl.listSessions()).items;

    // Session A: one reply, then renamed to a name that starts with "-".
    await r.ctl.send("Reply with a short greeting; do not use tools.");
    await waitFor("auto-title A", () => r.ctl.model.meta.title === DEFAULT_TITLE, 15_000);
    const a = r.ctl.model.meta.sessionId as string;
    expect((await ids()).map((s) => s.id)).toContain(a);
    await actions.rename(a, "-dash first name");
    expect(results.at(-1)).toMatchObject({ ok: true, message: "Renamed." });
    expect(r.ctl.model.meta.title).toBe("-dash first name");
    expect((await ids()).find((s) => s.id === a)?.title).toBe("-dash first name");

    // Session B: Hermes refuses a name A already has.
    await r.ctl.newChat();
    await r.ctl.send("Reply with a short greeting; do not use tools.");
    await waitFor("auto-title B", () => r.ctl.model.meta.title === DEFAULT_TITLE, 15_000);
    const b = r.ctl.model.meta.sessionId as string;
    await ids();
    await actions.rename(b, "-dash first name");
    expect(results.at(-1)).toMatchObject({
      ok: false,
      message: "Another session already has that name.",
    });

    // Delete B while it is on screen: the chat moves on, B leaves the list.
    await actions.delete(b);
    expect(results.at(-1)).toMatchObject({ ok: true });
    expect(r.ctl.model.meta.sessionId).not.toBe(b);
    expect((await ids()).map((s) => s.id)).not.toContain(b);

    // The running Hermes still held B in memory; after a restart only the
    // database speaks — B must not come back, A must still be there.
    await r.ctl.restart();
    await waitFor("ready again", () => r.ctl.model.meta.connection.state === "ready", 60_000);
    const after = (await ids()).map((s) => s.id);
    expect(after).not.toContain(b);
    expect(after).toContain(a);
  }, 180_000);

  it("/context for the pop-up: answered locally, no model call, nothing in the chat", async () => {
    const r = await rig();
    await r.ctl.send("Reply with a short greeting; do not use tools.");
    await waitFor("auto-title", () => r.ctl.model.meta.title === DEFAULT_TITLE, 15_000);
    const calls = r.fake.requests.length;
    const before = r.ctl.model.items;
    const report = await r.ctl.contextReport();
    expect(report).toMatch(/^Conversation: \d+ messages/m);
    expect(report).toMatch(/^Model: fixture-model$/m);
    expect(report).toMatch(/Context usage: ~[\d,]+ \/ [\d,]+ tokens/);
    const info = parseContextReport(report ?? "");
    expect(info?.size).toBe(DEFAULT_CONTEXT_LENGTH);
    expect(info?.byRole?.user).toBe(1);
    expect(r.fake.requests.length).toBe(calls); // no tokens spent
    expect(r.ctl.model.items).toEqual(before);
    // …and Hermes did not add it to the session: a second report counts the same.
    const again = parseContextReport((await r.ctl.contextReport()) ?? "");
    expect(again?.messages).toBe(info?.messages);
  });

  it("Stop cancels the running turn and shows the carry-over notice", async () => {
    const r = await rig(SLOW);
    const turn = r.ctl.send("Write a long answer.");
    await waitFor("streaming", () => text(r, "assistant").length > 0);
    await r.ctl.stop();
    await turn;
    expect(r.ctl.model.meta.busy).toBe(false);
    expect(items(r).some((i) => i.kind === "notice" && i.text === STOPPED_NOTICE)).toBe(true);
    // The reply stopped growing: Hermes really cancelled, not just our UI.
    const len = text(r, "assistant").length;
    await new Promise((res) => setTimeout(res, 1500));
    expect(text(r, "assistant").length).toBe(len);
  });

  it("New chat mid-turn leaves it working; Hermes runs a second chat meanwhile; it finishes whole", async () => {
    const r = await rig(MEDIUM);
    const turn = r.ctl.send("Write a long answer.");
    await waitFor("streaming", () => text(r, "assistant").length > 0);
    const first = r.ctl.model.meta.sessionId as string;
    await r.ctl.newChat();
    await waitFor("new session", () => r.ctl.model.meta.connection.state === "ready");
    expect(items(r)).toEqual([]);
    expect(r.ctl.backgroundSessions().map((s) => s.id)).toEqual([first]);
    // Two turns at once in one hermes acp: its pool runs up to 4.
    await r.ctl.send("And another long answer.");
    expect(text(r, "assistant")).toContain(MEDIUM_LAST);
    await turn;
    expect(r.bgDone).toEqual([{ id: first, outcome: "done" }]);
    // Hermes kept the whole background turn: reopening replays it.
    await r.ctl.openSaved(first);
    expect(text(r, "assistant")).toContain(MEDIUM_LAST);
  });

  it("going back to a chat still working shows the whole reply, once, and it finishes there", async () => {
    const r = await rig(MEDIUM);
    const turn = r.ctl.send("Write a long answer.");
    await waitFor("streaming", () => text(r, "assistant").length > 0);
    const first = r.ctl.model.meta.sessionId as string;
    await r.ctl.newChat();
    await waitFor("new session", () => r.ctl.model.meta.connection.state === "ready");
    await new Promise((res) => setTimeout(res, 1000)); // it works on, off screen
    await r.ctl.openSaved(first);
    expect(r.ctl.model.meta).toMatchObject({ busy: true, sessionId: first });
    const shown = text(r, "assistant").length;
    await turn;
    expect(r.ctl.model.meta.busy).toBe(false);
    const reply = text(r, "assistant");
    expect(reply.length).toBeGreaterThan(shown);
    expect(reply).toContain(MEDIUM_LAST);
    expect(reply.split("word0 ").length - 1).toBe(1); // nothing twice
    expect(r.bgDone).toEqual([]); // finished on screen
  });

  it("lists a finished session and reopens it with its history (slice 2)", async () => {
    const r = await rig();
    await r.ctl.send("Reply with a short greeting; do not use tools.");
    const id = r.ctl.model.meta.sessionId as string;
    expect(id).toBeTruthy();
    await r.ctl.newChat();
    expect(r.ctl.model.meta.sessionId).not.toBe(id);

    const page = await r.ctl.listSessions();
    const row = page.items.find((s) => s.id === id);
    expect(row).toBeDefined();
    expect(row?.title).toBeTruthy(); // Hermes always sends one
    expect(Number.isNaN(Date.parse(row?.updatedAt ?? ""))).toBe(false);

    await r.ctl.openSaved(id);
    expect(r.ctl.model.meta).toMatchObject({
      connection: { state: "ready" },
      sessionId: id,
      turn: 1,
    });
    expect(r.ctl.model.meta.model).toBe("fixture-model");
    const user = items(r).find((i) => i.kind === "user");
    expect(user && "text" in user ? user.text : "").toContain("short greeting");
    expect(text(r, "assistant")).toContain("Hello");
    expect(items(r).every((i) => i.turn === 1)).toBe(true);

    // Real Hermes answers `{}` for an id it does not have, and replays nothing.
    await r.ctl.openSaved("00000000-0000-4000-8000-000000000000");
    expect(items(r).map((i) => (i.kind === "notice" ? i.text : i.kind))).toEqual([
      "Hermes no longer has that session. This is a new chat.",
    ]);
    expect(r.ctl.model.meta.connection).toEqual({ state: "ready" });
  });

  it("offers modes and switches them; refuses a model no provider serves (slice 3)", async () => {
    const r = await rig();
    r.ctl.viewVisible();
    await waitFor("session ready", () => r.ctl.model.meta.connection.state === "ready");
    const m = r.ctl.model.meta;
    expect(m.modes?.map((x) => x.id)).toEqual(["default", "accept_edits", "dont_ask"]);
    expect(m.mode).toBe("default");
    expect(m.models?.some((c) => c.id === m.modelId)).toBe(true);

    await r.ctl.setMode("accept_edits");
    expect(r.ctl.model.meta.mode).toBe("accept_edits");

    // The sandbox has only the fake provider, so any other model is refused —
    // and the session must stay on the fake one (zero quota).
    const ok = await r.ctl.setModel("anthropic:claude-opus-5-5");
    expect(ok).toBe(false);
    expect(r.ctl.model.meta.modelId).toBe(m.modelId);
    expect(r.ctl.model.meta.switchingModel).toBeUndefined();
    const notice = items(r).find((i) => i.kind === "notice");
    expect(notice && "text" in notice ? notice.text : "").toMatch(/^Could not switch to /);
  });

  it("shutdown mid-turn stops Hermes inside 5 s and leaves no process behind", async () => {
    const r = await rig(SLOW);
    const turn = r.ctl.send("Write a long answer.");
    await waitFor("streaming", () => text(r, "assistant").length > 0);
    const root = r.pids[0] as number;
    const tree = [root, ...descendantPids(root)];
    const t0 = Date.now();
    await r.ctl.shutdown();
    expect(Date.now() - t0).toBeLessThan(5000);
    await turn;
    await waitFor("tree gone", () => alivePids(tree).length === 0, 5000);
  });
});
