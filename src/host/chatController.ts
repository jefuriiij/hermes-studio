// The chat: owns the ChatModel, the Hermes process, the session and the turn.
//
// No `vscode` import — every UI touchpoint (permission dialogs, notifications,
// the draft) is injected, so the integration tests drive this class against a
// fake ACP agent and the real hermes.exe.
//
// Invariants (each from the slice-1 review):
//   - Every session/update and permission request is routed by sessionId;
//     anything for a session that is neither current nor parked is dropped /
//     auto-cancelled. While session/new is in flight, updates for an unknown
//     session are buffered — Hermes sends usage/commands right after the
//     response, and they can reach us before the response does.
//   - At most one turn is on screen. It is `pending` from the moment of Send
//     (Stop then withdraws it — the prompt is never sent) and `active` once
//     session/prompt is out. Each turn has a token; a stale result is ignored.
//   - Leaving a chat whose turn is active (New chat, another session) PARKS it:
//     the turn keeps running in Hermes, and its chat is kept here, off screen,
//     and kept current from its updates. Going back shows that copy — never a
//     session/load, which would replay only up to the previous turn (Hermes
//     saves a turn's history when it ends). Its approvals wait for the user.
//   - start / New chat / Restart / opening a saved session run under one mutex.
//   - A turn ends however session/prompt settles — resolved OR rejected — and
//     tools still running are closed as failed.
//   - While a saved session loads, its replayed history is routed to the chat
//     even though it is not current yet: Hermes streams it BEFORE it answers
//     session/load.

import type * as acp from "@agentclientprotocol/sdk";

import {
  applyOps,
  type ChatModel,
  type ChatOp,
  type Connection,
  emptyModel,
  type MetaPatch,
  type PermissionItem,
  type QueuedMessage,
  type SentChip,
} from "../shared/chat";
import type { BackgroundSession, SessionSummary } from "../shared/protocol";
import { errorText, isSetupNeeded, sleep, TimeoutError } from "../logic/errors";
import { type Attachment, promptBlocks } from "../logic/attachments";
import { detectLimit } from "../logic/limits";
import { stopWhy } from "../logic/notify";
import { absorbedReply, canSendNow } from "../logic/queue";
import { cleanReplayedUser } from "../logic/replay";
import { mentionsSkill, skillPrompt } from "../logic/skills";
import {
  cancelled,
  describeCard,
  findDiff,
  isAllowKind,
  type PermissionCard,
  type PermissionResponse,
  selected,
} from "../logic/permissions";
import {
  closeTurnOps,
  isModelCommand,
  matchModel,
  modelSwitchedTo,
  reduceUpdate,
  sessionSettings,
  toolItemId,
} from "../logic/reducer";
import type { ExitInfo, HermesClient, HermesClientOptions } from "./hermesClient";
import { Mutex } from "./mutex";

export type Launch =
  | { ok: true; command: string; args: string[]; env: Record<string, string> }
  | { ok: false; message: string };

export interface ControllerDeps {
  /** The workspace folder the session is bound to. */
  folder(): { path: string; name: string } | undefined;
  /** How to start Hermes right now (resolver + env), or why it cannot start. */
  launch(): Launch;
  createClient(opts: HermesClientOptions): HermesClient;
  trace(): boolean;
  log(line: string): void;
  onStderrLine(line: string): void;
  /**
   * An approval card now waits in the chat (answered through answerPermission).
   * The place to get the user's attention when the view is hidden. Must not
   * throw, and must never answer on the user's behalf.
   */
  onPermission(item: PermissionItem): void;
  /** A chat working in the background asked for an approval; its card waits
   *  in that chat until the user goes back to it. Must not answer. */
  onBackgroundPermission?(item: PermissionItem, session: BackgroundSession): void;
  /** A chat working in the background finished — or failed, or Hermes gave up.
   *  `ms`: how long its turn ran. */
  onBackgroundDone?(session: BackgroundSession, outcome: "done" | "failed", ms: number): void;
  /** The chat on screen ended a turn that reached Hermes — not one you
   *  stopped, and not one New chat / Restart ended. */
  onTurnDone?(done: TurnDone): void;
  /** The chat with queued messages was left (New chat, another session,
   *  Restart): they go back to the composer, their files to its chips. */
  onQueueReturned?(
    items: { text: string; attachments: readonly Attachment[]; skills?: readonly string[] }[],
  ): void;
  /** The chats working in the background changed (the Sessions pop-up marks them). */
  onBackgroundChange?(sessions: BackgroundSession[]): void;
  now(): number;
}

export interface TurnDone {
  sessionId: string;
  title: string;
  /** Why it did not finish the job (a usage limit, an error); none: done. */
  why?: string;
  ms: number;
}

interface Session {
  id: string;
  clientId: number;
}

interface Turn {
  token: number;
  state: "pending" | "active";
  text: string;
  userItemId: string;
  number: number;
  /** deps.now() when it was sent. */
  startedAt: number;
  stopRequested: boolean;
  sessionId?: string;
  settled: Promise<void>;
  isModelCommand: boolean;
  replyText: string;
  /** What was attached, as the bubble shows it. */
  chips: SentChip[];
  attachments: readonly Attachment[];
  /** Named in the message ("/name", from the "/" menu or typed): Hermes
   *  loads them for this message. */
  skills?: readonly string[];
  /** Stopped by New chat / Restart, not by the user: the "Hermes will prepend
   *  the stopped request" notice would be false (Restart replaces the process;
   *  New chat clears the transcript anyway). */
  suppressStoppedNotice?: boolean;
  /** Hermes is running a queued prompt inside this turn (`/queue x`): it echoes
   *  it as a user_message_chunk and runs it as a nested turn. */
  inQueuedTurn?: boolean;
  /** Stop landed during that nested turn. Hermes then stores the stopped
   *  request for the next prompt, but the OUTER prompt still resolves
   *  end_turn — so `cancelled` alone cannot tell us. */
  stoppedDuringQueuedTurn?: boolean;
  /** Messages handed to this running reply ("Send now"), waiting for
   *  Hermes's one-line answer to that prompt (logic/queue.ts). */
  steers: string[];
  /** Of those, the ones Hermes queued instead: it echoes each one as a user
   *  message chunk when it runs it — the chat shows it already. */
  echoes: string[];
  /** After a message handed to the reply, Hermes's next words go BELOW its
   *  bubble: the messageIds seen before it are mapped to fresh ones. */
  alias: Map<string, string>;
}

/** A message typed while Hermes worked, waiting for the reply to end. */
interface Queued {
  id: string;
  text: string;
  attachments: readonly Attachment[];
  skills?: readonly string[];
}

interface OpenPermission {
  /** The card in the chat that shows this request. */
  itemId: string;
  sessionId: string;
  turnToken: number;
  /** The turn stopped / Hermes went away: settle as cancelled. */
  force(): void;
  /** Hermes stopped waiting (its approval timeout). */
  expire(): void;
  /** The user's choice; false if the option is not one Hermes offered. */
  answer(optionId: string | undefined): boolean;
}

/** A chat left while its turn runs: the turn goes on in Hermes, its chat is kept
 *  here (and kept current) until the user goes back or the turn ends. */
interface Parked {
  sessionId: string;
  clientId: number;
  turn: Turn;
  model: ChatModel;
}

/** A saved session being reopened: its replay is routed here until it answers. */
interface Loading {
  clientId: number;
  sessionId: string;
  /** Updates replayed so far; 0 plus an empty answer means Hermes lacks the id. */
  replayed: number;
}

export interface SessionPage {
  items: SessionSummary[];
  nextCursor?: string;
}

/** session/load answered for an id Hermes does not have (null / `{}`). */
class SessionGone extends Error {}

export const STOPPED_NOTICE =
  "Stopped. Hermes will prepend the stopped request to your next message — start a New chat to drop it.";

const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const SETTLE_MS = 1500;

export class ChatController {
  private _model: ChatModel = emptyModel();
  private readonly listeners = new Set<(ops: ChatOp[], model: ChatModel) => void>();
  private readonly mutex = new Mutex();
  private readonly idBase = Math.random().toString(36).slice(2, 8);
  private idSeq = 0;
  private turnSeq = 0;

  private client?: HermesClient;
  /** Old clients still shutting down (Restart, retire). Deactivation must wait
   *  for them too, or VS Code tears the host down before their tree-kill runs. */
  private readonly retiring = new Set<HermesClient>();
  private session?: Session;
  private pendingSession?: { clientId: number; buffered: { sessionId: string; update: unknown }[] };
  private loading?: Loading;
  /** Titles from the last session lists, shown while a session reopens (its
   *  load sends no title of its own). */
  private readonly knownTitles = new Map<string, string>();
  /** Every session a list showed for this folder: only those may be renamed
   *  or deleted from here. */
  private readonly listedIds = new Set<string>();
  /** Replayed user messages as Hermes sent them (see cleanReplayedUser). */
  private readonly replayUserRaw = new Map<string, string>();
  /** Sessions deleted from here, per Hermes process: a running `hermes acp`
   *  keeps a session it loaded in memory and lists it from there until it
   *  restarts (acp_adapter/session.py list_sessions), so hide them meanwhile. */
  private deleted?: { clientId: number; ids: Set<string> };
  private turn?: Turn;
  /** Chats working in the background, by session id. */
  private readonly parked = new Map<string, Parked>();
  /** The message whose turn hit a usage limit, sent again by continueWith. */
  private limitPrompt?: {
    text: string;
    attachments: readonly Attachment[];
    skills?: readonly string[];
  };
  /** A local command asked in the background (the context pop-up's
   *  `/context`): its reply text is caught here and never shown. */
  private probe?: { sessionId: string; text: string; done: Promise<void> };
  /** Messages typed while Hermes worked in the chat on screen, oldest first. */
  private queue: Queued[] = [];
  private readonly permissions = new Map<string, OpenPermission>();
  /** Full diff texts behind cards and steps, for "Open diff" (bounded). */
  private readonly diffs = new Map<string, { path: string; oldText: string; newText: string }>();
  private crashTimes: number[] = [];
  private autoStartBlocked = false;
  private disposed = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly deps: ControllerDeps) {}

  get model(): ChatModel {
    return this._model;
  }

  /** Subscribe to model changes; returns an unsubscribe function. */
  onChange(listener: (ops: ChatOp[], model: ChatModel) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ─── public actions ──────────────────────────────────────────────────────

  /** The view became visible: start Hermes eagerly the first time, so the
   *  ~4 s start is usually done before the user finishes typing. */
  viewVisible(): void {
    if (this.disposed || this.client || this.session) return;
    if (this._model.meta.connection.state !== "idle") return;
    void this.ensureSession().catch(() => undefined);
  }

  /**
   * Send a message, with what the composer's "+" attached. Resolves when the
   * turn is over: true if the prompt reached Hermes, false if it never went
   * out (the caller gives the attachments back to the composer then).
   */
  async send(
    rawText: string,
    attachments: readonly Attachment[] = [],
    skills: readonly string[] = [],
  ): Promise<boolean> {
    const text = rawText.replace(/\s+$/, "");
    if (!text.trim() || this.turn || this.disposed) return false;
    const c = this._model.meta.connection.state;
    if (c === "noFolder" || c === "notFound" || c === "setupNeeded") return false;
    // Hermes would hold a prompt that lands mid-switch and run it later as a
    // nested turn; the composer is disabled meanwhile, this is the backstop.
    if (this._model.meta.switchingModel) return false;
    const chips: SentChip[] = [
      // A skill typed in the text shows there; only one not in it gets a chip.
      ...skills
        .filter((k) => !mentionsSkill(text, k))
        .map((k) => ({ kind: "skill" as const, label: k })),
      ...attachments.map(sentChip),
    ];
    let sent = false;
    /** The reply ended by itself: the next queued message may go. */
    let clean = false;

    const token = ++this.turnSeq;
    const number = this._model.meta.turn + 1;
    const userItemId = this.newId("user~");
    let markSettled: () => void = () => undefined;
    const settled = new Promise<void>((r) => {
      markSettled = r;
    });
    this.turn = {
      token,
      state: "pending",
      text,
      userItemId,
      number,
      startedAt: this.deps.now(),
      stopRequested: false,
      settled,
      isModelCommand: skills.length === 0 && isModelCommand(text),
      ...(skills.length ? { skills } : {}),
      replyText: "",
      chips,
      attachments,
      steers: [],
      echoes: [],
      alias: new Map(),
    };
    this.apply([
      // A new message answers any limit banner: it is sent as typed.
      { op: "meta", patch: { turn: number, busy: true, limit: null } },
      {
        op: "add",
        item: {
          kind: "user",
          id: userItemId,
          text,
          turn: number,
          ...(chips.length ? { attachments: chips } : {}),
        },
      },
    ]);

    let client: HermesClient | undefined;
    try {
      const session = await this.ensureSession();
      // A background `/context` (the context pop-up) catches every reply
      // chunk while it runs: let it finish first. It is local and quick.
      if (this.probe) await this.probe.done;
      const t = this.currentTurn(token);
      if (!t || t.stopRequested) return sent;
      client = this.client;
      if (!client || session.clientId !== client.id) throw new Error("Hermes restarted");
      t.state = "active";
      t.sessionId = session.id;
      sent = true;
      const first = skills.length ? skillPrompt(skills, text) : text;
      const res = await client.prompt(session.id, promptBlocks(first, attachments));
      const now = this.currentTurn(token);
      if (now) {
        this.onPromptResolved(res);
        const why = stopWhy(res.stopReason, this._model.meta.limit);
        this.turnDone(now, why);
        // The queue goes on only after a reply that ended by itself: not
        // after Stop, a usage limit or an error (it would fail the same way).
        clean = !why && !now.stopRequested && !now.suppressStoppedNotice;
      } else this.parkedTurnEnded(token, res.stopReason === "end_turn" ? "done" : "failed");
    } catch (e) {
      // A prompt that failed because Hermes died rejects a moment before the
      // exit is reported; wait for it so the header says "Stopped" by the time
      // the turn ends, and the next send starts a fresh process.
      if (client && !client.alive) await Promise.race([client.down, sleep(1500)]);
      const t = this.currentTurn(token);
      if (t) {
        this.onPromptFailed(t, e);
        if (t.state === "active") {
          const c = this._model.meta.connection;
          this.turnDone(
            t,
            c.state === "stopped" ? c.message : `Hermes reported an error: ${errorText(e)}`,
          );
        }
      } else this.parkedTurnEnded(token, "failed");
    } finally {
      markSettled();
      if (this.currentTurn(token)) this.endTurn();
      if (clean && !this.turn) queueMicrotask(() => this.sendNextQueued());
    }
    return sent;
  }

  // ─── messages typed while Hermes works ───────────────────────────────────

  /** A turn is pending or running in the chat on screen: a message now queues. */
  get working(): boolean {
    return this.turn !== undefined;
  }

  /** Keep a message for when the reply ends (the composer's Enter while Hermes works). */
  enqueue(
    text: string,
    attachments: readonly Attachment[] = [],
    skills: readonly string[] = [],
  ): void {
    const t = text.replace(/\s+$/, "");
    if (!t.trim() || this.disposed) return;
    this.queue.push({
      id: this.newId("queued~"),
      text: t,
      attachments,
      ...(skills.length ? { skills } : {}),
    });
    this.publishQueue();
  }

  /** Take a queued message out (× or ✏); the caller gives its files back. */
  removeQueued(id: string): Queued | undefined {
    const i = this.queue.findIndex((q) => q.id === id);
    if (i < 0) return undefined;
    const [q] = this.queue.splice(i, 1);
    this.publishQueue();
    return q;
  }

  /**
   * "Send now": into the reply Hermes is writing (it reads it at its next
   * step — logic/queue.ts), or, when Hermes is idle, as a normal message.
   */
  async sendQueuedNow(id: string): Promise<void> {
    const q = this.queue.find((x) => x.id === id);
    if (!q) return;
    const t = this.turn;
    if (!t) {
      this.removeQueued(id);
      const sent = await this.send(q.text, q.attachments, q.skills);
      if (!sent) {
        this.queue.unshift(q);
        this.publishQueue();
      }
      return;
    }
    const client = this.client;
    if (t.state !== "active" || !t.sessionId || !client?.alive) return; // not started yet: it waits
    if (!canSendNow(q.attachments)) return;
    this.removeQueued(id);
    // One text block: Hermes redirects only a text-only prompt it can read as one string.
    const first = q.skills?.length ? skillPrompt(q.skills, q.text) : q.text;
    const whole = [
      first,
      ...q.attachments.map((a) => (a.block.type === "text" ? a.block.text : "")),
    ]
      .filter(Boolean)
      .join("\n\n");
    for (const [messageId, now] of t.alias) t.alias.set(messageId, `${now}~`);
    for (const it of this._model.items) {
      if (it.turn !== t.number || (it.kind !== "assistant" && it.kind !== "thought")) continue;
      if (it.messageId && !t.alias.has(it.messageId)) t.alias.set(it.messageId, `${it.messageId}~`);
    }
    const chips = q.attachments.map(sentChip);
    this.apply([
      {
        op: "add",
        item: {
          kind: "user",
          id: this.newId("user~"),
          text: q.text,
          turn: t.number,
          steered: true,
          ...(chips.length ? { attachments: chips } : {}),
        },
      },
    ]);
    t.steers.push(whole);
    try {
      await client.prompt(t.sessionId, [{ type: "text", text: whole }]);
    } catch (e) {
      const i = t.steers.indexOf(whole);
      if (i >= 0) t.steers.splice(i, 1);
      this.notice("error", `Hermes did not take the message: ${errorText(e)}`);
    }
  }

  private sendNextQueued(): void {
    if (this.turn || this.disposed) return;
    const q = this.queue.shift();
    if (!q) return;
    this.publishQueue();
    void this.send(q.text, q.attachments, q.skills).then((sent) => {
      if (sent) return;
      this.queue.unshift(q);
      this.publishQueue();
    });
  }

  private publishQueue(): void {
    const view: QueuedMessage[] = this.queue.map((q) => {
      const chips = [
        ...(q.skills ?? [])
          .filter((k) => !mentionsSkill(q.text, k))
          .map((k) => ({ kind: "skill" as const, label: k })),
        ...q.attachments.map(sentChip),
      ];
      return {
        id: q.id,
        text: q.text,
        ...(chips.length ? { chips } : {}),
        canSendNow: canSendNow(q.attachments),
      };
    });
    this.apply([{ op: "meta", patch: { queue: view.length ? view : null } }]);
  }

  /** Leaving the chat: its queued messages go back to the composer. */
  private handBackQueue(): void {
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    this.publishQueue();
    try {
      this.deps.onQueueReturned?.(
        items.map((q) => ({
          text: q.text,
          attachments: q.attachments,
          ...(q.skills?.length ? { skills: q.skills } : {}),
        })),
      );
    } catch (e) {
      this.deps.log(`[ext] queue hand-back failed: ${errorText(e)}`);
    }
  }

  /** Stop the current turn. Pending: withdraw it. Active: session/cancel. */
  async stop(): Promise<void> {
    const t = this.turn;
    if (!t || t.stopRequested) return;
    t.stopRequested = true;
    if (t.state === "pending") {
      // The webview puts the text back in the composer when it sees this
      // bubble turn `notSent` (derived from the op, so no extra message).
      this.markNotSent(t);
      this.endTurn();
      return;
    }
    // Snapshot now, not at resolve time: a Stop that lands during Hermes's
    // slash reply (before the queued prompt starts) is not honored by Hermes.
    t.stoppedDuringQueuedTurn = t.inQueuedTurn === true;
    this.forcePermissions((p) => p.turnToken === t.token);
    if (this.client && t.sessionId) {
      await this.client
        .cancel(t.sessionId)
        .catch((e: unknown) => this.deps.log(`[ext] cancel failed: ${errorText(e)}`));
    }
  }

  newChat(): Promise<void> {
    this.withdrawPendingTurn();
    this.handBackQueue();
    return this.mutex.run(async () => {
      await this.leaveCurrentTurn();
      this.session = undefined;
      this.limitPrompt = undefined;
      // Clear FIRST: the new session's first notifications can arrive before
      // session/new resolves, and a later clear would wipe them.
      this.apply([
        { op: "clear" },
        {
          op: "meta",
          patch: { title: null, usage: null, sessionId: null, limit: null, busy: false },
        },
      ]);
      if (this.client?.alive) await this.openSession().catch(() => undefined);
    });
  }

  /**
   * Hermes's `/context` report, asked without a trace in the chat (the
   * context pop-up). In `hermes acp` it is a local command: no model call,
   * nothing added to the conversation. Only while idle — a reply streaming
   * now would mix in — and a send waits for it.
   */
  async contextReport(): Promise<string | undefined> {
    if (this.turn || this.loading || this.probe || this.disposed) return undefined;
    const client = this.client;
    const session = this.session;
    if (!client?.alive || !session || session.clientId !== client.id) return undefined;
    let finish: () => void = () => undefined;
    const done = new Promise<void>((r) => {
      finish = r;
    });
    const probe = { sessionId: session.id, text: "", done };
    this.probe = probe;
    try {
      const timeout = sleep(10_000).then(() => {
        throw new TimeoutError("/context", 10_000);
      });
      await Promise.race([client.prompt(session.id, "/context"), timeout]);
      return probe.text;
    } catch (e) {
      this.deps.log(`[ext] /context for the context pop-up failed: ${errorText(e)}`);
      return undefined;
    } finally {
      if (this.probe === probe) this.probe = undefined;
      finish();
    }
  }

  /** Hermes advertised image prompts (promptCapabilities.image). Before it has
   *  started, assume yes: Hermes 0.21.5 does, and a send starts it anyway. */
  acceptsImages(): boolean {
    const caps = this.client?.initializeResult?.agentCapabilities?.promptCapabilities;
    return caps ? caps.image === true : true;
  }

  /** The title of a session of THIS folder, if a session list has named it.
   *  Only such sessions may be opened from elsewhere (the panels): loading a
   *  session from another folder would rebind it to this one. */
  sessionTitle(sessionId: string): string | undefined {
    return this.knownTitles.get(sessionId);
  }

  /** The name of the chat on screen, as a notification says it. */
  currentTitle(): string {
    const id = this._model.meta.sessionId ?? "";
    return this.titleOf(id, this._model);
  }

  /** Sessions with an approval card waiting for the user. */
  waitingSessions(): string[] {
    return [...new Set([...this.permissions.values()].map((p) => p.sessionId))];
  }

  /** Why this session may not be renamed or deleted now (undefined: it may). */
  sessionChangeBlocked(sessionId: string, action: "rename" | "delete"): string | undefined {
    // Working first: a chat in its first reply is not in Hermes's list yet.
    if (action === "delete" && this._model.meta.sessionId === sessionId && this.turn) {
      return "Hermes is working in it. Stop it, or wait until it has finished.";
    }
    if (this.parked.has(sessionId)) {
      return "It is still working in the background. Try again when it has finished.";
    }
    if (!this.listedIds.has(sessionId)) return "That session is not in this folder's list.";
    return undefined;
  }

  /** Before the chat on screen is deleted: move to a new chat. */
  async leaveSession(sessionId: string): Promise<void> {
    if (this.session?.id === sessionId || this._model.meta.sessionId === sessionId) {
      await this.newChat();
    }
  }

  /** Hermes deleted it: never list or offer it again from this Hermes process. */
  forgetSession(sessionId: string): void {
    const clientId = this.client?.id ?? -1;
    if (this.deleted?.clientId !== clientId) this.deleted = { clientId, ids: new Set() };
    this.deleted.ids.add(sessionId);
    this.knownTitles.delete(sessionId);
    this.listedIds.delete(sessionId);
  }

  /** Hermes renamed it. It sends no update for that: the header follows here. */
  sessionRenamed(sessionId: string, title: string): void {
    this.knownTitles.set(sessionId, title);
    if (this._model.meta.sessionId === sessionId) this.apply([{ op: "meta", patch: { title } }]);
  }

  /** One page of this folder's saved sessions, newest first. Starts Hermes if
   *  it is not running — the list lives in Hermes, nowhere else — the same way
   *  opening the view does, so the header ends up "Ready", not "Starting". */
  async listSessions(cursor?: string): Promise<SessionPage> {
    const folder = this.deps.folder();
    if (!folder) throw new Error("Open a folder to see its sessions.");
    const session = await this.ensureSession();
    const client = this.client;
    if (!client?.alive || client.id !== session.clientId) throw new Error("Hermes restarted");
    const res = await client.listSessions(folder.path, cursor);
    const gone = this.deleted?.clientId === client.id ? this.deleted.ids : undefined;
    const items: SessionSummary[] = [];
    for (const s of Array.isArray(res?.sessions) ? res.sessions : []) {
      if (typeof s?.sessionId !== "string" || !s.sessionId) continue;
      if (gone?.has(s.sessionId)) continue;
      this.listedIds.add(s.sessionId);
      const title = typeof s.title === "string" && s.title.trim() ? s.title.trim() : undefined;
      if (title) this.knownTitles.set(s.sessionId, title);
      items.push({
        id: s.sessionId,
        ...(title ? { title } : {}),
        ...(typeof s.updatedAt === "string" ? { updatedAt: s.updatedAt } : {}),
      });
    }
    const next = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
    return next ? { items, nextCursor: next } : { items };
  }

  /**
   * Reopen a saved session in place of the current chat. A running turn goes
   * on in the background, as for New chat. A chat working in the background
   * comes back as it is now, still working. If Hermes no longer has the
   * session, or the load fails, the chat says so and continues as a fresh
   * session — never left without one.
   */
  openSaved(sessionId: string): Promise<void> {
    this.withdrawPendingTurn();
    return this.mutex.run(async () => {
      const s = this.session;
      if (s?.id === sessionId && this.client?.alive && s.clientId === this.client.id) return;
      this.handBackQueue();
      const back = this.parked.get(sessionId);
      if (back && this.client?.alive && back.clientId === this.client.id) {
        await this.leaveCurrentTurn();
        this.unpark(back);
        return;
      }
      await this.leaveCurrentTurn();
      const folder = this.deps.folder();
      if (!folder) {
        this.setConnection({ state: "noFolder" });
        return;
      }
      let client: HermesClient;
      try {
        client = await this.ensureClient(folder);
      } catch {
        return; // the header already shows why Hermes is not running
      }

      this.session = undefined;
      this.pendingSession = undefined;
      this.limitPrompt = undefined;
      this.replayUserRaw.clear();
      // Turn 0: the replay counts turns up again from its user messages.
      this.apply([
        { op: "clear" },
        {
          op: "meta",
          patch: {
            turn: 0,
            title: this.knownTitles.get(sessionId) ?? null,
            usage: null,
            model: null,
            modelId: null,
            switchingModel: null,
            sessionId: null,
            limit: null,
            busy: false,
          },
        },
      ]);
      this.setConnection({ state: "starting", detail: "Opening session…" });
      const loading: Loading = { clientId: client.id, sessionId, replayed: 0 };
      this.loading = loading;
      try {
        const res = await client.loadSession(folder.path, sessionId);
        if (this.client !== client) throw new Error("Hermes restarted");
        if (!res?.models && loading.replayed === 0) throw new SessionGone();
        this.loading = undefined;
        this.session = { id: sessionId, clientId: client.id };
        // A tool call the history has no result for was cut off: not running.
        this.apply(closeTurnOps(this._model));
        this.setConnection(
          { state: "ready" },
          { ...sessionSettings(res), folder: folder.name, sessionId },
        );
      } catch (e) {
        if (this.loading === loading) this.loading = undefined;
        // A newer client (Restart) owns the chat now; it is not ours to touch.
        if (this.client !== client && this.client !== undefined) return;
        const why =
          e instanceof SessionGone
            ? "Hermes no longer has that session."
            : `Could not open that session: ${errorText(e)}`;
        // A half-replayed transcript would look like the real thing: drop it.
        this.apply([{ op: "clear" }, { op: "meta", patch: { turn: 0, title: null } }]);
        if (!client.alive) {
          // Hermes died meanwhile; the header says so and the next send restarts it.
          this.notice("error", why);
          return;
        }
        if (e instanceof TimeoutError) {
          this.notice("error", `${why} Your next message starts a new session.`);
          await this.retire(client);
          this.setConnection({ state: "error", message: why });
          return;
        }
        this.notice("error", `${why} This is a new chat.`);
        await this.openSession().catch(() => undefined);
      }
    });
  }

  restart(): Promise<void> {
    this.withdrawPendingTurn();
    this.handBackQueue();
    return this.mutex.run(async () => {
      await this.stopAndSettle();
      // The process goes, and the chats working in the background with it.
      const dropped = this.dropParked();
      const old = this.client;
      this.client = undefined;
      this.session = undefined;
      this.pendingSession = undefined;
      this.loading = undefined;
      this.autoStartBlocked = false;
      this.crashTimes = [];
      if (old) await this.retireClient(old);
      if (this._model.items.length > 0 || dropped > 0) {
        this.notice(
          "info",
          `Restarted Hermes — this is a new session.${backgroundStopped(dropped)}`,
        );
      }
      await this.openSession().catch(() => undefined);
    });
  }

  /**
   * Switch the model and keep the conversation (Hermes rebuilds the agent on
   * the new model with the same history). Only between turns: Hermes refuses
   * mid-turn, and the menu is disabled then. A message sent during the switch
   * waits for it (it queues on the same mutex).
   */
  /** Resolves true when the session is on `modelId` afterwards. */
  setModel(modelId: string): Promise<boolean> {
    return this.mutex.run(async () => {
      if (this.turn) {
        this.notice("warning", "Switch models when Hermes is idle: press Stop first.");
        return false;
      }
      const choice = this._model.meta.models?.find((m) => m.id === modelId);
      const label = choice?.label ?? modelId;
      if (modelId === this._model.meta.modelId && this.session) return true;
      let session: Session;
      try {
        session = await this.openSession();
      } catch {
        return false; // the header says why there is no session
      }
      const client = this.client;
      if (!client?.alive || client.id !== session.clientId) return false;
      if (modelId === this._model.meta.modelId) return true;
      this.apply([{ op: "meta", patch: { switchingModel: label } }]);
      try {
        await client.setModel(session.id, modelId);
        if (this.client !== client || this.session?.id !== session.id) return false;
        this.apply([{ op: "meta", patch: { model: label, modelId, switchingModel: null } }]);
        this.notice("info", `Switched to ${label}. The conversation continues with it.`);
        return true;
      } catch (e) {
        this.apply([{ op: "meta", patch: { switchingModel: null } }]);
        this.notice("error", `Could not switch to ${label}: ${errorText(e)}`);
        return false;
      }
    });
  }

  /**
   * The answer to a usage limit: move to another model and send the message
   * that hit the limit again, in the same session. Hermes keeps the failed
   * request in its history as "not processed", so sending it again is exactly
   * what its own copy advises ("switch models with /model").
   */
  async continueWith(modelId: string): Promise<void> {
    const prompt = this.limitPrompt;
    if (!(await this.setModel(modelId))) return;
    this.dismissLimit();
    // With what it had attached: the files are read again, fresh.
    if (prompt) await this.send(prompt.text, prompt.attachments, prompt.skills);
  }

  dismissLimit(): void {
    this.limitPrompt = undefined;
    this.apply([{ op: "meta", patch: { limit: null } }]);
  }

  /** Switch the edit-approval mode for this session (Default asks before edits). */
  setMode(modeId: string): Promise<void> {
    return this.mutex.run(async () => {
      if (modeId === this._model.meta.mode) return;
      let session: Session;
      try {
        session = await this.openSession();
      } catch {
        return;
      }
      const client = this.client;
      if (!client?.alive || client.id !== session.clientId) return;
      const name = this._model.meta.modes?.find((m) => m.id === modeId)?.name ?? modeId;
      try {
        await client.setMode(session.id, modeId);
        if (this.client === client && this.session?.id === session.id) {
          this.apply([{ op: "meta", patch: { mode: modeId } }]);
        }
      } catch (e) {
        this.notice("error", `Could not switch to "${name}": ${errorText(e)}`);
      }
    });
  }

  /**
   * A turn still waiting for Hermes to start sits in ensureSession, queued on
   * the mutex AHEAD of New chat / Restart — it would send its prompt the moment
   * the start finished, before the lifecycle action ever ran. Withdraw it now,
   * synchronously, so the queued continuation finds no turn and never sends.
   */
  private withdrawPendingTurn(): void {
    const t = this.turn;
    if (t?.state === "pending") {
      t.suppressStoppedNotice = true;
      void this.stop();
    }
  }

  /** Extension deactivation. Not behind the mutex: it must never wait for a
   *  slow start to finish before it can stop Hermes. */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      this.disposed = true;
      const client = this.client;
      const t = this.turn;
      this.forcePermissions(() => true);
      await Promise.all([
        client?.shutdown({
          ...(t?.state === "active" && t.sessionId ? { cancelSessionId: t.sessionId } : {}),
          turnSettled: t?.settled,
        }),
        // HermesClient.shutdown is idempotent: these reuse the in-flight stop.
        ...[...this.retiring].map((c) => c.shutdown()),
      ]);
    })();
    return this.shutdownPromise;
  }

  private async retireClient(c: HermesClient): Promise<void> {
    this.retiring.add(c);
    try {
      await c.shutdown();
    } finally {
      this.retiring.delete(c);
    }
  }

  // ─── session lifecycle ───────────────────────────────────────────────────

  private ensureSession(): Promise<Session> {
    const s = this.session;
    if (s && this.client?.alive && s.clientId === this.client.id) return Promise.resolve(s);
    return this.mutex.run(() => this.openSession());
  }

  /** Must be called under the mutex. */
  private async openSession(): Promise<Session> {
    const existing = this.session;
    if (existing && this.client?.alive && existing.clientId === this.client.id) return existing;
    if (this.disposed) throw new Error("Hermes Studio is shutting down");

    const folder = this.deps.folder();
    if (!folder) {
      this.setConnection({ state: "noFolder" });
      throw new Error("Open a folder to chat with Hermes.");
    }

    const client = await this.ensureClient(folder);

    // Session-scoped header state belongs to the session being replaced: clear
    // it now (plan §5.1). The new session's own usage/title are buffered while
    // session/new is in flight and applied after the response, so they land.
    this.setConnection(
      { state: "starting", detail: "Creating session…" },
      {
        model: null,
        modelId: null,
        usage: null,
        title: null,
        sessionId: null,
        switchingModel: null,
      },
    );
    this.pendingSession = { clientId: client.id, buffered: [] };
    try {
      const res = await client.newSession(folder.path);
      if (this.client !== client) throw new Error("Hermes restarted");
      const session = { id: res.sessionId, clientId: client.id };
      const buffered = this.pendingSession?.buffered ?? [];
      this.session = session;
      this.pendingSession = undefined;
      this.setConnection(
        { state: "ready" },
        { ...sessionSettings(res), folder: folder.name, sessionId: session.id },
      );
      for (const b of buffered) if (b.sessionId === session.id) this.applyUpdate(b.update);
      return session;
    } catch (e) {
      this.pendingSession = undefined;
      if (this.client === client || this.client === undefined) {
        if (isSetupNeeded(e)) {
          this.setConnection({ state: "setupNeeded", message: errorText(e) });
        } else {
          this.setConnection({
            state: "error",
            message: `Could not create a session: ${errorText(e)}`,
          });
          // A hung Hermes will not recover by waiting; start clean next time.
          if (e instanceof TimeoutError) await this.retire(client);
        }
      }
      throw e;
    }
  }

  /** Must be called under the mutex. The running client, or a newly started one. */
  private async ensureClient(folder: { path: string; name: string }): Promise<HermesClient> {
    const running = this.client;
    if (running?.alive) return running;
    if (this.disposed) throw new Error("Hermes Studio is shutting down");
    if (this.autoStartBlocked) {
      throw new Error("Hermes stopped repeatedly. Press Restart to try again.");
    }
    const launch = this.deps.launch();
    if (!launch.ok) {
      this.setConnection({ state: "notFound", message: launch.message });
      throw new Error(launch.message);
    }
    const client = this.createClient(launch, folder.path);
    this.client = client;
    this.setConnection({ state: "starting", detail: "Starting Hermes…" }, { folder: folder.name });
    try {
      const init = await client.start();
      this.apply([{ op: "meta", patch: { agentVersion: init.agentInfo?.version } }]);
      return client;
    } catch (e) {
      // The failed start's own cleanup may already have cleared this.client
      // (its exit is reported as expected). Show the error unless a NEWER
      // client has taken over in the meantime.
      if (this.client === client) this.client = undefined;
      if (this.client === undefined) {
        this.setConnection({ state: "error", message: `Hermes did not start: ${errorText(e)}` });
      }
      throw e;
    }
  }

  private createClient(launch: Extract<Launch, { ok: true }>, cwd: string): HermesClient {
    const client: HermesClient = this.deps.createClient({
      command: launch.command,
      args: launch.args,
      cwd,
      env: launch.env,
      trace: this.deps.trace(),
      log: (l) => this.deps.log(l),
      onStderrLine: (l) => this.deps.onStderrLine(l),
      onSessionUpdate: (p) => this.handleUpdate(client, p.sessionId, p.update),
      onPermissionRequest: (req) => this.handlePermission(client, req),
      onExit: (info) => this.handleExit(client, info),
    });
    return client;
  }

  private async retire(client: HermesClient): Promise<void> {
    if (this.client === client) {
      this.client = undefined;
      this.session = undefined;
      this.loading = undefined;
    }
    await this.retireClient(client).catch(() => undefined);
  }

  // ─── events from Hermes ──────────────────────────────────────────────────

  private handleUpdate(client: HermesClient, sessionId: string, update: unknown): void {
    if (client !== this.client) return;
    const loading = this.loading;
    if (loading && loading.clientId === client.id && loading.sessionId === sessionId) {
      loading.replayed++;
      this.applyReplayUpdate(update);
      return;
    }
    const parked = this.parked.get(sessionId);
    if (parked && parked.clientId === client.id) {
      const title = parked.model.meta.title;
      parked.model = applyOps(parked.model, this.updateOps(parked.model, parked.turn, update));
      if (parked.model.meta.title !== title) this.publishBackground();
      return;
    }
    if (!this.session || this.session.id !== sessionId) {
      if (this.pendingSession?.clientId === client.id) {
        this.pendingSession.buffered.push({ sessionId, update });
      } else {
        this.deps.log(`[ext] dropped an update for session ${sessionId} (not current)`);
      }
      return;
    }
    const probe = this.probe;
    if (probe && probe.sessionId === sessionId) {
      const u = update as { sessionUpdate?: unknown; content?: { type?: unknown; text?: unknown } };
      if (u?.sessionUpdate === "agent_message_chunk") {
        if (u.content?.type === "text" && typeof u.content.text === "string") {
          probe.text += u.content.text;
        }
        return; // the report is for the pop-up, not the chat
      }
    }
    this.applyUpdate(update);
  }

  private applyUpdate(update: unknown): void {
    this.apply(this.updateOps(this._model, this.turn, update));
  }

  /** What a live update does to a chat — the one on screen, or a parked one —
   *  given that chat's turn. */
  private updateOps(model: ChatModel, t: Turn | undefined, update: unknown): ChatOp[] {
    const u = (typeof update === "object" && update !== null ? update : {}) as Record<
      string,
      unknown
    >;

    // Hermes ends a permission request it gave up on (timeout) with a
    // tool_call_update for the synthetic id; a dialog still open is now moot.
    if (u.sessionUpdate === "tool_call_update" && typeof u.toolCallId === "string") {
      if (u.status === "failed" || u.status === "completed") {
        this.permissions.get(u.toolCallId)?.expire();
      }
    }

    // Hermes emits user_message_chunk live only when it runs a queued prompt
    // (`/queue x`) inside the current turn (replay is slice 2).
    if (t?.state === "active" && u.sessionUpdate === "user_message_chunk") t.inQueuedTurn = true;

    // `/model x` typed by hand: Hermes sends no notification, only the text.
    if (t?.isModelCommand && u.sessionUpdate === "agent_message_chunk") {
      const c = u.content as { type?: unknown; text?: unknown } | undefined;
      if (c?.type === "text" && typeof c.text === "string") t.replyText += c.text;
    }

    let next: unknown = update;
    if (t) {
      const c = u.content as { type?: unknown; text?: unknown } | undefined;
      const text = c?.type === "text" && typeof c.text === "string" ? c.text : undefined;
      // Hermes's one-line answer to a message handed to the reply ("Send
      // now"): the bubble already says it went; keep it out of the reply.
      if (u.sessionUpdate === "agent_message_chunk" && !u.messageId && text && t.steers.length) {
        const how = absorbedReply(text);
        if (how) {
          const sent = t.steers.shift();
          if (how === "queued" && sent) t.echoes.push(sent);
          return [];
        }
      }
      // Hermes queued it instead and runs it now: it is on screen already.
      if (u.sessionUpdate === "user_message_chunk" && text && t.echoes.length) {
        const i = t.echoes.findIndex((e) => e.trim() === text.trim());
        if (i >= 0) {
          t.echoes.splice(i, 1);
          return [];
        }
      }
      // Words after a handed-in message go below its bubble.
      const alias = typeof u.messageId === "string" ? t.alias.get(u.messageId) : undefined;
      if (alias) next = { ...u, messageId: alias };
    }

    this.noteStepDiff(next);
    return reduceUpdate(model, next, {
      turn: model.meta.turn,
      newId: (p) => this.newId(p),
    });
  }

  /** An edit step carries its diff: keep the full texts for "Open diff" (the
   *  model only holds the folded view). */
  private noteStepDiff(update: unknown): void {
    const u = update as { sessionUpdate?: unknown; toolCallId?: unknown; content?: unknown } | null;
    if (u?.sessionUpdate !== "tool_call" && u?.sessionUpdate !== "tool_call_update") return;
    if (typeof u.toolCallId !== "string" || !Array.isArray(u.content)) return;
    const d = findDiff(u.content);
    if (d)
      this.rememberDiff(toolItemId(u.toolCallId), {
        path: d.path,
        oldText: d.oldText ?? "",
        newText: d.newText,
      });
  }

  /** A saved session's history, streamed by session/load. Each replayed user
   *  message starts a new turn, so the "Hermes" labels and step cards group the
   *  way they did live. */
  private applyReplayUpdate(update: unknown): void {
    const kind = (update as { sessionUpdate?: unknown } | null)?.sessionUpdate;
    if (kind === "user_message_chunk") {
      this.apply([{ op: "meta", patch: { turn: this._model.meta.turn + 1 } }]);
    }
    this.noteStepDiff(update);
    this.apply(
      reduceUpdate(this._model, update, {
        turn: this._model.meta.turn,
        newId: (p) => this.newId(p),
      }),
    );
    if (kind === "user_message_chunk") this.cleanReplayedUser(update);
  }

  /** A replayed user message carries the notes the editor added to it (the
   *  "/" skill, the file you were in): show them as the chips they were. The
   *  raw text is kept per item, as a message may come in several chunks. */
  private cleanReplayedUser(update: unknown): void {
    const last = this._model.items.at(-1);
    const c = (update as { content?: { type?: unknown; text?: unknown } }).content;
    if (last?.kind !== "user" || c?.type !== "text" || typeof c.text !== "string") return;
    const raw = (this.replayUserRaw.get(last.id) ?? "") + c.text;
    this.replayUserRaw.set(last.id, raw);
    const clean = cleanReplayedUser(raw);
    if (clean.chips.length === 0) return;
    this.apply([{ op: "replace", item: { ...last, text: clean.text, attachments: clean.chips } }]);
  }

  private handlePermission(
    client: HermesClient,
    req: acp.RequestPermissionRequest,
  ): Promise<PermissionResponse> {
    this.deps.log(`[ext] permission request: ${safeJson(req.toolCall)}`);
    const live = client === this.client && !client.isStopping && !this.disposed;
    const cur = this.turn;
    const onScreen =
      live && this.session?.id === req.sessionId && cur?.state === "active" && !cur.stopRequested;
    // A chat working in the background: the card waits in it for the user.
    const parked = this.parked.get(req.sessionId);
    const inBackground =
      !onScreen && live && parked?.clientId === client.id && !parked.turn.stopRequested;
    const t = onScreen ? cur : inBackground ? parked?.turn : undefined;
    const chat = onScreen ? this._model : parked?.model;
    if (!t || !chat) {
      // Not for anything the user is looking at or left working: never show a dialog for it.
      return Promise.resolve(cancelled());
    }

    let card: PermissionCard;
    try {
      card = describeCard(req);
    } catch (e) {
      this.deps.log(`[ext] could not describe permission request: ${errorText(e)}`);
      return Promise.resolve(cancelled());
    }
    const key = req.toolCall.toolCallId;
    const itemId = this.newId("perm~");
    const { fullDiff, ...shown } = card;
    if (fullDiff) this.rememberDiff(itemId, fullDiff);
    const item: PermissionItem = {
      kind: "permission",
      id: itemId,
      turn: chat.meta.turn,
      ...shown,
      state: "pending",
    };
    const sessionId = req.sessionId;
    this.changeChat(sessionId, [{ op: "add", item }]);

    return new Promise<PermissionResponse>((resolve) => {
      let settled = false;
      // The card records how it ended: buttons turn into a line of text, so a
      // late click can never look as if it counted. It is in whichever chat
      // holds it now (the user may have gone back to a parked one).
      const settle = (
        r: PermissionResponse,
        state: PermissionItem["state"],
        answer?: PermissionItem["answer"],
      ) => {
        if (settled) return;
        settled = true;
        this.permissions.delete(key);
        const current = this.chatOf(sessionId)?.items.find((i) => i.id === itemId);
        if (current?.kind === "permission") {
          this.changeChat(sessionId, [
            { op: "replace", item: { ...current, state, ...(answer ? { answer } : {}) } },
          ]);
        }
        if (this.parked.has(sessionId)) this.publishBackground();
        resolve(r);
      };
      this.permissions.set(key, {
        itemId,
        sessionId,
        turnToken: t.token,
        force: () => settle(cancelled(), "cancelled"),
        expire: () => settle(cancelled(), "expired"),
        answer: (optionId) => {
          if (optionId === undefined) {
            settle(cancelled(), "cancelled");
            return true;
          }
          // Only an option Hermes offered; approval is decided by its kind.
          const o = item.options.find((x) => x.optionId === optionId);
          if (!o) return false;
          settle(selected(o.optionId), "answered", {
            label: o.label,
            allowed: isAllowKind(o.kind),
          });
          return true;
        },
      });
      try {
        if (onScreen) {
          this.deps.onPermission(item);
        } else {
          this.publishBackground();
          const s = this.backgroundSessions().find((b) => b.id === sessionId);
          if (s) this.deps.onBackgroundPermission?.(item, s);
        }
      } catch (e) {
        this.deps.log(`[ext] permission notification failed: ${errorText(e)}`);
      }
    });
  }

  /**
   * The user's click on an approval card. `undefined` withdraws without an
   * answer (Hermes treats that as Deny). False when the card is no longer
   * waiting — Hermes timed out, or the turn stopped — or the option is unknown.
   */
  answerPermission(itemId: string, optionId?: string): boolean {
    for (const p of this.permissions.values()) {
      if (p.itemId === itemId) return p.answer(optionId);
    }
    return false;
  }

  /** The full texts behind a card's (or a step's) diff, for "Open diff". */
  diffFor(itemId: string): { path: string; oldText: string; newText: string } | undefined {
    return this.diffs.get(itemId);
  }

  private rememberDiff(
    itemId: string,
    diff: { path: string; oldText: string; newText: string },
  ): void {
    this.diffs.set(itemId, diff);
    // Bounded: only recent cards are likely to be opened.
    while (this.diffs.size > 50) {
      const oldest = this.diffs.keys().next().value;
      if (oldest === undefined) break;
      this.diffs.delete(oldest);
    }
  }

  private handleExit(client: HermesClient, info: ExitInfo): void {
    if (client !== this.client) return;
    this.client = undefined;
    this.session = undefined;
    this.pendingSession = undefined;
    this.loading = undefined;
    this.forcePermissions(() => true);
    // The chats working in the background went with the process.
    const dropped = this.dropParked();
    // The transcript stays for reading, but it is no longer attached to a live
    // session: the next message starts a new one.
    this.apply([{ op: "meta", patch: { sessionId: null } }]);
    // A spawn that failed (ENOENT/EACCES) never ran: not a crash. The start
    // error path already says "Hermes did not start: <reason>".
    if (info.expected || info.spawnFailed || this.disposed) return;

    const now = this.deps.now();
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (this.crashTimes.length >= CRASH_LIMIT) this.autoStartBlocked = true;
    const how = info.signal ? `signal ${info.signal}` : `exit code ${info.code ?? "?"}`;
    const next = `${
      this.autoStartBlocked
        ? "It stopped 3 times in a minute — press Restart to try again."
        : "Your next message starts a new session."
    }${backgroundStopped(dropped)}`;
    this.setConnection({
      state: "stopped",
      message: `Hermes stopped unexpectedly (${how}). ${next}`,
    });
    // With a turn running, its failed prompt adds the notice (onPromptFailed).
    if (!this.turn) this.notice("error", `Hermes stopped unexpectedly (${how}). ${next}`);
  }

  // ─── turns ───────────────────────────────────────────────────────────────

  private onPromptResolved(res: acp.PromptResponse): void {
    const t = this.turn;
    // Hermes keeps a stopped request and prepends it to the next prompt. It
    // does that for a cancelled turn, and also when Stop hit a queued prompt's
    // nested turn — where the outer prompt still resolves end_turn.
    const carriesOver = res.stopReason === "cancelled" || t?.stoppedDuringQueuedTurn === true;
    if (carriesOver && !t?.suppressStoppedNotice) {
      this.notice("info", STOPPED_NOTICE, "newChat");
    }
    switch (res.stopReason) {
      case "refusal":
        // Hermes answers refusal when it no longer knows the session.
        this.session = undefined;
        this.apply([{ op: "meta", patch: { sessionId: null } }]);
        this.notice(
          "error",
          "Hermes no longer has this session. Start a New chat, or your next message starts a new session.",
          "newChat",
        );
        break;
      case "max_tokens":
      case "max_turn_requests":
        this.notice("warning", `Hermes stopped early (${res.stopReason.replace(/_/g, " ")}).`);
        break;
      case "end_turn":
        if (t) this.checkForLimit(t);
        break;
      default:
        break;
    }
    if (t?.isModelCommand) {
      // Hermes replies with the bare model name ("qwen3:32b"); use it verbatim —
      // cutting at a colon would show "32b".
      const name = modelSwitchedTo(t.replyText);
      if (name) {
        // Mark it in the menu too — or nothing, rather than the old model.
        const id = matchModel(this._model.meta.models ?? [], name) ?? null;
        this.apply([{ op: "meta", patch: { model: name, modelId: id } }]);
      }
    }
  }

  /** A provider that gave up (usage limit, overload) ends the turn normally
   *  with Hermes's explanation as the reply — the only signal there is
   *  (logic/limits.ts). Offer to continue on another model. */
  private checkForLimit(t: Turn): void {
    let reply: string | undefined;
    for (let i = this._model.items.length - 1; i >= 0; i--) {
      const it = this._model.items[i];
      if (!it || it.turn !== t.number) break;
      if (it.kind === "assistant") {
        reply = it.text;
        break;
      }
    }
    const limit = reply ? detectLimit(reply) : undefined;
    if (!limit) return;
    this.limitPrompt = {
      text: t.text,
      attachments: t.attachments,
      ...(t.skills?.length ? { skills: t.skills } : {}),
    };
    this.apply([{ op: "meta", patch: { limit } }]);
  }

  private onPromptFailed(t: Turn, e: unknown): void {
    if (t.state === "pending") {
      // Never reached Hermes (start or session/new failed): say so on the bubble.
      this.markNotSent(t);
      this.notice("error", `Not sent: ${errorText(e)}`);
      return;
    }
    // Hermes died mid-turn: the SDK's "connection closed" says nothing useful;
    // the exit message (code, what happens next) does.
    const c = this._model.meta.connection;
    if (c.state === "stopped") {
      this.notice("error", c.message);
      return;
    }
    this.notice("error", `Hermes reported an error: ${errorText(e)}`);
  }

  private endTurn(): void {
    const t = this.turn;
    this.turn = undefined;
    if (t) this.forcePermissions((p) => p.turnToken === t.token);
    // The reply's footer says how long it took (mock board 23).
    const asked =
      t?.state === "active" ? this._model.items.find((i) => i.id === t.userItemId) : undefined;
    const took: ChatOp[] =
      asked?.kind === "user"
        ? [
            {
              op: "replace",
              item: { ...asked, ms: Math.max(0, this.deps.now() - (t?.startedAt ?? 0)) },
            },
          ]
        : [];
    this.apply([...closeTurnOps(this._model), ...took, { op: "meta", patch: { busy: false } }]);
  }

  /** Stop the turn (if any) for New chat / Restart and wait ≤ 1.5 s for it to
   *  settle. No "carries over" notice: the session is being replaced. */
  private async stopAndSettle(): Promise<void> {
    const t = this.turn;
    if (!t) return;
    t.suppressStoppedNotice = true;
    await this.stop();
    await Promise.race([t.settled, sleep(SETTLE_MS)]);
    if (this.turn?.token === t.token) this.endTurn();
  }

  // ─── chats working in the background ─────────────────────────────────────

  /** Leaving this chat (New chat, another session): a turn Hermes is running
   *  goes on in the background; one not sent yet was withdrawn already. */
  private async leaveCurrentTurn(): Promise<void> {
    if (!this.park()) await this.stopAndSettle();
  }

  /** Park the turn on screen if Hermes is running it: its chat is kept here. */
  private park(): boolean {
    const t = this.turn;
    const s = this.session;
    const client = this.client;
    if (t?.state !== "active" || t.stopRequested || !s || t.sessionId !== s.id) return false;
    if (!client?.alive || client.isStopping || s.clientId !== client.id) return false;
    this.parked.set(s.id, { sessionId: s.id, clientId: s.clientId, turn: t, model: this._model });
    this.turn = undefined;
    this.publishBackground();
    return true;
  }

  /** Go back to a parked chat: on screen again as it is now, still working. */
  private unpark(p: Parked): void {
    this.parked.delete(p.sessionId);
    this.session = { id: p.sessionId, clientId: p.clientId };
    this.pendingSession = undefined;
    this.loading = undefined;
    this.limitPrompt = undefined;
    this.turn = p.turn;
    this.show(p.model);
    this.publishBackground();
  }

  /** A parked turn ended off screen. Hermes holds its whole history now, so
   *  the copy kept here goes (going back loads the session), and the user is told. */
  private parkedTurnEnded(token: number, outcome: "done" | "failed"): void {
    const p = [...this.parked.values()].find((x) => x.turn.token === token);
    if (!p) return; // Restart or a crash dropped it: already said
    const summary = this.backgroundSummary(p);
    this.parked.delete(p.sessionId);
    this.forcePermissions((x) => x.turnToken === token);
    this.publishBackground();
    try {
      this.deps.onBackgroundDone?.(summary, outcome, this.deps.now() - p.turn.startedAt);
    } catch (e) {
      this.deps.log(`[ext] background notification failed: ${errorText(e)}`);
    }
  }

  /** The turn on screen ended: tell the user (who may be elsewhere) — unless
   *  they stopped it, or New chat / Restart did. `why`: it did not finish. */
  private turnDone(t: Turn, why: string | undefined): void {
    if (t.stopRequested || t.suppressStoppedNotice || !t.sessionId) return;
    // Not "finished" yet: the queued message goes out next.
    if (!why && this.queue.length > 0) return;
    try {
      this.deps.onTurnDone?.({
        sessionId: t.sessionId,
        title: this.titleOf(t.sessionId, this._model),
        ...(why ? { why } : {}),
        ms: this.deps.now() - t.startedAt,
      });
    } catch (e) {
      this.deps.log(`[ext] notification failed: ${errorText(e)}`);
    }
  }

  /** A chat's name: Hermes's title, else its first message (a new chat has
   *  no title until Hermes names it). */
  private titleOf(sessionId: string, model: ChatModel): string {
    const first = model.items.find((i) => i.kind === "user");
    return (
      model.meta.title ??
      this.knownTitles.get(sessionId) ??
      (first?.kind === "user" ? clipLine(first.text, 80) : "New chat")
    );
  }

  /** Restart or a crash: the process is gone, its background chats with it. */
  private dropParked(): number {
    const n = this.parked.size;
    if (n === 0) return 0;
    const tokens = new Set([...this.parked.values()].map((p) => p.turn.token));
    this.parked.clear();
    this.forcePermissions((p) => tokens.has(p.turnToken));
    this.publishBackground();
    return n;
  }

  /** The chats working in the background, for the Sessions pop-up. */
  backgroundSessions(): BackgroundSession[] {
    return [...this.parked.values()].map((p) => this.backgroundSummary(p));
  }

  private backgroundSummary(p: Parked): BackgroundSession {
    const waiting = [...this.permissions.values()].some((x) => x.sessionId === p.sessionId);
    const title = this.titleOf(p.sessionId, p.model);
    return { id: p.sessionId, title, state: waiting ? "waiting" : "working" };
  }

  private publishBackground(): void {
    try {
      this.deps.onBackgroundChange?.(this.backgroundSessions());
    } catch (e) {
      this.deps.log(`[ext] background update failed: ${errorText(e)}`);
    }
  }

  /** A session's chat: a parked one, or the one on screen. */
  private chatOf(sessionId: string): ChatModel | undefined {
    const p = this.parked.get(sessionId);
    if (p) return p.model;
    return this.session?.id === sessionId ? this._model : undefined;
  }

  /** Change a session's chat wherever it is (dropped if it is neither). */
  private changeChat(sessionId: string, ops: ChatOp[]): void {
    const p = this.parked.get(sessionId);
    if (p) p.model = applyOps(p.model, ops);
    else if (this.session?.id === sessionId) this.apply(ops);
  }

  /** Put a whole chat on screen: a parked one coming back. */
  private show(next: ChatModel): void {
    const patch: Record<string, unknown> = { ...next.meta };
    for (const k of Object.keys(this._model.meta)) if (!(k in next.meta)) patch[k] = null;
    // The process's state is today's, not the one when the chat was left.
    delete patch.agentVersion;
    delete patch.folder;
    patch.connection = { state: "ready" };
    this.apply([
      { op: "clear" },
      ...next.items.map((item): ChatOp => ({ op: "add", item })),
      { op: "meta", patch: patch as MetaPatch },
    ]);
  }

  private currentTurn(token: number): Turn | undefined {
    return this.turn?.token === token ? this.turn : undefined;
  }

  private markNotSent(t: Turn): void {
    this.apply([
      {
        op: "replace",
        item: {
          kind: "user",
          id: t.userItemId,
          text: t.text,
          turn: t.number,
          notSent: true,
          ...(t.chips.length ? { attachments: t.chips } : {}),
        },
      },
    ]);
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private forcePermissions(match: (p: OpenPermission) => boolean): void {
    for (const p of [...this.permissions.values()]) if (match(p)) p.force();
  }

  private setConnection(connection: Connection, extra: MetaPatch = {}): void {
    this.apply([{ op: "meta", patch: { ...extra, connection } }]);
  }

  private notice(level: "info" | "warning" | "error", text: string, action?: "newChat"): void {
    this.apply([
      {
        op: "add",
        item: {
          kind: "notice",
          id: this.newId("notice~"),
          level,
          text,
          turn: this._model.meta.turn,
          ...(action ? { action } : {}),
        },
      },
    ]);
  }

  private newId(prefix: string): string {
    return `${prefix}${this.idBase}-${++this.idSeq}`;
  }

  private apply(ops: ChatOp[]): void {
    if (ops.length === 0) return;
    const next = applyOps(this._model, ops);
    if (next === this._model) return;
    this._model = next;
    for (const l of this.listeners) {
      try {
        l(ops, next);
      } catch (e) {
        this.deps.log(`[ext] listener threw: ${errorText(e)}`);
      }
    }
  }
}

/** The first line, cut to `n` characters. */
function clipLine(text: string, n: number): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length <= n ? line : `${line.slice(0, n - 1)}…`;
}

/** " The chat working in the background stopped too." (or "2 chats …"; "" for none). */
function backgroundStopped(n: number): string {
  if (n === 0) return "";
  return n === 1
    ? " The chat working in the background stopped too."
    : ` ${n} chats working in the background stopped too.`;
}

/** A sent message's chip. Only an image keeps its id (and size): the bubble
 *  asks the host for the picture by it. */
function sentChip(a: Attachment): SentChip {
  const chip: SentChip = { kind: a.kind, label: a.label };
  if (a.kind === "image") {
    chip.id = a.id;
    if (a.size) chip.size = a.size;
  }
  return chip;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
