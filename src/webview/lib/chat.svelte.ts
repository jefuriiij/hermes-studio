// The webview's copy of the chat model, plus the composer draft.
//
// The host owns the model; this copy only ever changes through the same
// applyOps() the host runs, so the two cannot drift (src/shared/chat.ts).

import { tick } from "svelte";
import { SvelteMap } from "svelte/reactivity";

import {
  applyOps,
  type ChatModel,
  type ChatOp,
  emptyModel,
  type QueuedMessage,
} from "$shared/chat";
import type { EffortLevel, EffortState } from "$shared/effort";
import type { HubSkill, PanelsView } from "$shared/panels";
import type {
  AccountUsage,
  BackgroundSession,
  ContextChip,
  ContextInfo,
  EditorChip,
  HostToWebview,
  PathHit,
  SessionActionResult,
  SessionList,
} from "$shared/protocol";
import { takesDraft } from "./draft";
import { isTab, type Tab } from "./panels";
import { stoppedPromptTexts } from "./restore";
import { imageSrc, makeThumb } from "./thumbs";
import { getState, post, setState } from "./vscode";

class ChatStore {
  /**
   * $state.raw, not $state: applyOps never mutates and hands back fresh
   * references for exactly the items that changed, so a deep proxy would only
   * add cost. Unchanged items keep their identity and their DOM.
   */
  model = $state.raw<ChatModel>(emptyModel());

  #draft = $state(getState()?.draft ?? "");
  #composer: HTMLElement | undefined;

  /** The chat lives in this page. false: it is in the editor tab, and this
   *  side bar page shows where it went; its panel tabs keep working. */
  here = $state(true);
  /** The text last taken from the host (see takesDraft). */
  #taken: string | undefined;
  #draftTimer: ReturnType<typeof setTimeout> | undefined;

  /** A queued message (mock board 17): into the running reply, or sent now. */
  sendQueuedNow(id: string): void {
    post({ type: "queueSendNow", id });
  }

  removeQueued(id: string): void {
    post({ type: "queueRemove", id });
  }

  /** ✏: back into the text box (in front of what it holds), files to the chips. */
  editQueued(q: QueuedMessage): void {
    post({ type: "queueRemove", id: q.id, restore: true });
    // A skill chip is a skill not typed in the text: it goes in front, as "/name".
    const chips = (q.chips ?? []).filter((c) => c.kind === "skill").map((c) => `/${c.label}`);
    this.#putBack(chips.length ? `${chips.join(" ")} ${q.text}` : q.text, undefined);
    this.focusComposer();
  }

  #putBack(text: string, skill: string | undefined): void {
    this.draft = this.#draft.trim() ? `${text}\n\n${this.#draft}` : text;
    if (skill && !this.#skill) this.skill = skill;
  }

  /** The side bar's buttons while the chat is in the editor tab. */
  showChat(): void {
    post({ type: "showChat" });
  }

  moveChatHere(): void {
    post({ type: "moveChatHere" });
  }

  /** The tab on screen: Chat, or one of Hermes's panels. Kept across reloads. */
  #tab = $state<Tab>(((t) => (isTab(t) ? t : "chat"))(getState()?.tab));
  /** The panels' data, as the host last sent it (null: not read yet). */
  panels = $state.raw<PanelsView | null>(null);

  get tab(): Tab {
    return this.#tab;
  }

  /** Switch tabs. Menus and pop-ups belong to the chat: they close. */
  setTab(tab: Tab): void {
    if (tab === this.#tab) return;
    this.menu = null;
    this.sessionsOpen = false;
    this.#sessionsOpener = null;
    this.preview = null;
    this.#tab = tab;
    this.#persist();
    if (tab === "chat") return;
    post({ type: "refreshPanels" });
    this.#markSeen();
  }

  /** A click in a panel: the host opens what this key names. */
  openPanel(key: string | undefined): void {
    if (key) post({ type: "panelOpen", key });
  }

  /** The ↻ in a panel: read Hermes's files again; it spins until they land. */
  refreshing = $state(false);
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  refreshPanels(): void {
    this.refreshing = true;
    post({ type: "refreshPanels" });
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => (this.refreshing = false), 8000);
  }

  // ── The Memory tab's answers (mock boards 27A/B) ─────────────────────────
  /** Proposals being answered right now, and how: their buttons wait. */
  reviewing = new SvelteMap<string, "approve" | "reject">();
  /** The last answer, under the proposals: "Added to Notes.", or why not. */
  reviewNote = $state.raw<{ ok: boolean; text: string } | null>(null);
  /** This Hermes can't be answered from here: the tab shows the CLI way. */
  reviewUnavailable = $state(false);
  #reviewText = new Map<string, string>();
  #reviewTimer: ReturnType<typeof setTimeout> | undefined;

  /** Approve one (if any), then reject these; `done` is what to say after. */
  reviewMemory(approve: string | undefined, reject: readonly string[], done: string): void {
    const ids = [...(approve ? [approve] : []), ...reject];
    if (ids.length === 0 || ids.some((id) => this.reviewing.has(id))) return;
    for (const id of ids) this.reviewing.set(id, id === approve ? "approve" : "reject");
    this.#reviewText.set(ids.join(" "), done);
    this.reviewNote = null;
    post({ type: "memoryReview", ...(approve ? { approve } : {}), reject: [...reject] });
  }

  // ── "Get more" skills from the Skills Hub (mock board 28) ────────────────
  hub = $state.raw<{ items: HubSkill[]; loading: boolean; error?: string; asked: boolean }>({
    items: [],
    loading: false,
    asked: false,
  });
  #hubSeq = 0;
  /** Per identifier: installing, installed (this time), or why not. */
  installs = new SvelteMap<
    string,
    { state: "installing" | "installed" | "failed"; message?: string }
  >();

  searchHub(query: string, official: boolean): void {
    this.hub = { ...this.hub, loading: true, asked: true };
    post({ type: "hubSearch", query, official, seq: ++this.#hubSeq });
  }

  installSkill(identifier: string): void {
    if (this.installs.get(identifier)?.state === "installing") return;
    this.installs.set(identifier, { state: "installing" });
    post({ type: "hubInstall", identifier });
  }

  /** On the Learning tab, what Hermes changed is seen (the badge clears). */
  #markSeen(): void {
    if (this.#tab === "learning" && (this.panels?.learning.unseen ?? 0) > 0) {
      post({ type: "panelSeen" });
    }
  }

  #persist(): void {
    setState({ draft: this.#draft, tab: this.#tab });
  }

  /** The Sessions pop-up is open (over the chat). UI-only: the host never sees it. */
  sessionsOpen = $state(false);
  #sessionsOpener: HTMLElement | null = null;
  /** The composer menu that is open, if any (the limit banner opens one too). */
  menu = $state<"model" | "mode" | "add" | "context" | null>(null);
  /** Hermes's saved sessions for this folder, as the host last reported them. */
  sessions = $state.raw<SessionList>({ items: [], loading: false });
  /** Chats working in the background (the pop-up marks them, on top). */
  background = $state.raw<BackgroundSession[]>([]);
  /** Subscription limits per provider slug, for the model menu. */
  accountUsage = $state.raw<AccountUsage>({ byProvider: {}, loading: [] });

  /** Hermes's `/context` report for the context pop-up (null: not now). */
  contextInfo = $state.raw<{ info: ContextInfo | null; loading: boolean }>({
    info: null,
    loading: false,
  });

  requestContextInfo(): void {
    this.contextInfo = { ...this.contextInfo, loading: true };
    post({ type: "contextInfo" });
  }

  /** Hermes's reasoning effort setting (the modes pop-up). */
  effort = $state.raw<EffortState>({ value: null, loading: false, saving: false });

  refreshEffort(): void {
    post({ type: "refreshEffort" });
  }

  setEffort(level: EffortLevel): void {
    post({ type: "setEffort", level });
  }

  /** The file you are in (goes along with the next message unless ×-ed). */
  editor = $state.raw<EditorChip | null>(null);

  toggleEditor(): void {
    post({ type: "toggleEditorContext" });
  }

  /** What the "+" attached to the next message. The host owns the list. */
  context = $state.raw<{ items: ContextChip[]; images: boolean }>({ items: [], images: true });

  addContext(kind: ContextChip["kind"]): void {
    this.menu = null;
    post({ type: "addContext", kind });
  }

  removeContext(id: string): void {
    post({ type: "removeContext", id });
  }

  /** The image shown over the chat: loading until the host sends the picture
   *  (`src`), or `missing` if it no longer has it. */
  preview = $state.raw<{
    id: string;
    label: string;
    size?: string;
    src?: string;
    missing?: boolean;
  } | null>(null);
  #previewOpener: HTMLElement | null = null;

  /** Chip thumbnails by chip id; null: the host has no picture, show the icon. */
  thumbs = new SvelteMap<string, string | null>();
  #thumbsWanted = new Set<string>();

  /** An image chip is on screen: fetch its picture once and shrink it. */
  wantThumb(id: string): void {
    if (this.thumbs.has(id) || this.#thumbsWanted.has(id)) return;
    this.#thumbsWanted.add(id);
    post({ type: "previewImage", id });
  }

  openImage(chip: { id?: string; label: string; size?: string }): void {
    if (!chip.id) return;
    this.#previewOpener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.preview = { id: chip.id, label: chip.label, ...(chip.size ? { size: chip.size } : {}) };
    post({ type: "previewImage", id: chip.id });
  }

  closeImage(): void {
    this.preview = null;
    const opener = this.#previewOpener;
    this.#previewOpener = null;
    // The chat was inert under the preview: focus once it is live again.
    void tick().then(() => opener?.isConnected && opener.focus());
  }

  /** Show the Sessions pop-up with a fresh first page. */
  openSessions(): void {
    this.preview = null;
    this.menu = null;
    if (!this.sessionsOpen) {
      this.#sessionsOpener =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    this.sessionsOpen = true;
    this.refreshSessions();
  }

  /** The title (and the History button) open and close it. */
  toggleSessions(): void {
    if (this.sessionsOpen) this.closeSessions("escape");
    else this.openSessions();
  }

  /** Esc gives focus back to where it was; a click elsewhere keeps its own. */
  closeSessions(why: "escape" | "outside" | "pick"): void {
    if (!this.sessionsOpen) return;
    this.sessionsOpen = false;
    const opener = this.#sessionsOpener;
    this.#sessionsOpener = null;
    if (why === "escape" && opener?.isConnected) opener.focus();
    else if (why === "pick" || (why === "escape" && !opener)) this.focusComposer();
  }

  refreshSessions(): void {
    post({ type: "listSessions" });
  }

  /** The skill picked from the "/" menu for the next message (a chip). */
  #skill = $state<string | null>(null);

  get skill(): string | null {
    return this.#skill;
  }

  set skill(value: string | null) {
    this.#skill = value;
    this.#syncDraft();
  }

  /** The "@" list: the host's answer to the latest search. */
  fileResults = $state.raw<{ seq: number; items: PathHit[] }>({ seq: 0, items: [] });
  #fileSeq = 0;

  searchFiles(query: string): void {
    post({ type: "fileSearch", query, seq: ++this.#fileSeq });
  }

  mentionFile(path: string): void {
    post({ type: "mentionFile", path });
  }

  /** Paths Hermes wrote in `code`, and whether each is a real file (the host
   *  checks; mock board 23). A "no" is asked again after the next reply —
   *  Hermes may create the file. */
  files = new SvelteMap<string, boolean>();
  #askedPaths = new Set<string>();

  checkPaths(paths: readonly string[]): void {
    const fresh = [...new Set(paths)].filter((p) => !this.#askedPaths.has(p)).slice(0, 50);
    if (fresh.length === 0) return;
    for (const p of fresh) this.#askedPaths.add(p);
    post({ type: "checkPaths", paths: fresh });
  }

  #forgetMissingPaths(): void {
    for (const [p, ok] of this.files) {
      if (ok) continue;
      this.files.delete(p);
      this.#askedPaths.delete(p);
    }
  }

  /** The last rename / delete from the Sessions pop-up, for its status line. */
  sessionAction = $state.raw<SessionActionResult | null>(null);
  #sessionActionTimer: ReturnType<typeof setTimeout> | undefined;

  renameSession(sessionId: string, title: string): void {
    post({ type: "renameSession", sessionId, title });
  }

  deleteSession(sessionId: string): void {
    post({ type: "deleteSession", sessionId });
  }

  moreSessions(): void {
    const cursor = this.sessions.nextCursor;
    if (cursor && !this.sessions.loading) post({ type: "listSessions", cursor });
  }

  /** Continue a saved session: the host replaces the transcript with its replay. */
  openSession(sessionId: string): void {
    this.closeSessions("pick");
    if (sessionId !== this.model.meta.sessionId) post({ type: "openSession", sessionId });
  }

  get draft(): string {
    return this.#draft;
  }

  /** Every write is persisted, so a reload or a hidden view keeps the draft. */
  set draft(value: string) {
    this.#draft = value;
    this.#persist();
    this.#syncDraft();
  }

  /** The host keeps a copy of the draft, so it can move with the chat
   *  between the side bar and the editor tab. */
  #syncDraft(): void {
    if (!this.here) return;
    clearTimeout(this.#draftTimer);
    this.#draftTimer = setTimeout(() => this.#postDraft(), 200);
  }

  #postDraft(): void {
    this.#draftTimer = undefined;
    post({ type: "draft", text: this.#draft, ...(this.#skill ? { skill: this.#skill } : {}) });
  }

  focusComposer(): void {
    this.#composer?.focus();
  }

  /** The composer's textarea registers itself so `focusComposer` can reach it
   *  (an attachment: `{@attach (el) => chat.registerComposer(el)}`). */
  registerComposer(el: HTMLElement): () => void {
    this.#composer = el;
    return () => {
      if (this.#composer === el) this.#composer = undefined;
    };
  }

  apply(msg: HostToWebview): void {
    switch (msg.type) {
      case "init":
        // A malformed snapshot would take the whole view down; keep what we have.
        if (Array.isArray(msg.model?.items) && typeof msg.model.meta === "object") {
          this.model = msg.model;
        }
        break;
      case "ops": {
        const before = this.model;
        this.model = applyOps(before, msg.ops);
        this.#restoreStoppedPrompt(before, msg.ops);
        if (before.meta.busy && !this.model.meta.busy) this.#forgetMissingPaths();
        break;
      }
      case "paths":
        if (msg.known && typeof msg.known === "object") {
          for (const [p, ok] of Object.entries(msg.known)) this.files.set(p, ok === true);
        }
        break;
      case "focusComposer":
        // The chat is `inert` under an image preview (and under another tab),
        // and an inert element cannot take focus: let that reach the DOM first.
        this.setTab("chat");
        this.sessionsOpen = false;
        this.preview = null;
        void tick().then(() => this.#composer?.focus());
        break;
      case "sessions":
        if (Array.isArray(msg.list?.items)) this.sessions = msg.list;
        break;
      case "showSessions":
        // The History button in the view's title bar: open, or close again.
        // From another tab it always opens, on the Chat tab.
        if (this.#tab !== "chat") {
          this.setTab("chat");
          this.openSessions();
        } else {
          this.toggleSessions();
        }
        break;
      case "background":
        if (Array.isArray(msg.sessions)) this.background = msg.sessions;
        break;
      case "fileResults":
        // An answer to an older search (slower than the next key) is dropped.
        if (Array.isArray(msg.items) && msg.seq === this.#fileSeq) {
          this.fileResults = { seq: msg.seq, items: msg.items };
        }
        break;
      case "sessionAction":
        if (!msg.result || typeof msg.result.message !== "string") break;
        this.sessionAction = msg.result;
        clearTimeout(this.#sessionActionTimer);
        // A refusal stays until the next try; a success fades.
        if (msg.result.ok) {
          this.#sessionActionTimer = setTimeout(() => (this.sessionAction = null), 5000);
        }
        break;
      case "panels":
        if (msg.view && typeof msg.view === "object" && Array.isArray(msg.view.learning?.items)) {
          this.panels = msg.view;
          this.#markSeen();
        }
        this.refreshing = false;
        break;
      case "memoryReviewed": {
        if (!Array.isArray(msg.ids)) break;
        for (const id of msg.ids) this.reviewing.delete(id);
        const key = msg.ids.join(" ");
        const done = this.#reviewText.get(key);
        this.#reviewText.delete(key);
        this.reviewNote = msg.ok
          ? { ok: true, text: done ?? "Done." }
          : { ok: false, text: msg.message ?? "Hermes couldn't answer it." };
        if (msg.unavailable) this.reviewUnavailable = true;
        clearTimeout(this.#reviewTimer);
        // A refusal stays until the next answer; a success fades.
        if (msg.ok) this.#reviewTimer = setTimeout(() => (this.reviewNote = null), 8000);
        break;
      }
      case "hubResults":
        if (msg.seq === this.#hubSeq && Array.isArray(msg.items)) {
          this.hub = {
            items: msg.items,
            loading: false,
            asked: true,
            ...(msg.error ? { error: msg.error } : {}),
          };
        }
        break;
      case "hubInstalled":
        if (typeof msg.identifier !== "string") break;
        this.installs.set(
          msg.identifier,
          msg.ok
            ? { state: "installed" }
            : { state: "failed", message: msg.message ?? "Not installed." },
        );
        break;
      case "contextInfo":
        this.contextInfo = { info: msg.info ?? null, loading: false };
        break;
      case "effort":
        if (msg.effort && typeof msg.effort === "object") this.effort = msg.effort;
        break;
      case "editorContext":
        this.editor = msg.file && typeof msg.file.label === "string" ? msg.file : null;
        break;
      case "accountUsage":
        if (msg.usage && typeof msg.usage.byProvider === "object") this.accountUsage = msg.usage;
        break;
      case "context":
        if (Array.isArray(msg.items)) this.context = { items: msg.items, images: msg.images };
        break;
      case "imagePreview": {
        const src = imageSrc(msg.image);
        if (this.#thumbsWanted.delete(msg.id)) {
          const id = msg.id;
          if (!src) this.thumbs.set(id, null);
          else void makeThumb(src).then((t) => this.thumbs.set(id, t ?? null));
        }
        const p = this.preview;
        if (!p || p.id !== msg.id) break; // closed, or another one opened since
        this.preview = src ? { ...p, src } : { ...p, missing: true };
        break;
      }
      case "chatPlace": {
        const here = msg.here !== false;
        if (here) {
          // A page that becomes the chat's home with a draft of its own (the
          // one VS Code kept over a reload) tells the host about it.
          if (this.#draft.trim()) this.#syncDraft();
        } else if (this.here) {
          // The chat moved to the editor tab. Keys the host has not seen yet
          // go now (they move with it), and this page keeps nothing of the chat.
          if (this.#draftTimer !== undefined) {
            clearTimeout(this.#draftTimer);
            this.#postDraft();
          }
          this.menu = null;
          this.sessionsOpen = false;
          this.#sessionsOpener = null;
          this.preview = null;
          this.#skill = null;
          this.#draft = "";
          this.#taken = undefined;
          this.#persist();
        }
        this.here = here;
        break;
      }
      case "draftBack":
        if (typeof msg.text !== "string" || !this.here) break;
        this.#putBack(msg.text, typeof msg.skill === "string" ? msg.skill : undefined);
        break;
      case "takeDraft":
        if (typeof msg.text !== "string" || !this.here) break;
        if (!takesDraft(this.#draft, this.#taken)) break;
        this.#taken = msg.text;
        this.#draft = msg.text;
        this.#skill = typeof msg.skill === "string" ? msg.skill : null;
        this.#persist();
        break;
      case "focusPermission":
        // From the "Hermes is waiting for your approval" notification: bring
        // the card into view and focus its FIRST button, which is Deny.
        this.setTab("chat");
        this.sessionsOpen = false;
        this.preview = null;
        void tick().then(() => {
          const card = document.querySelector(`[data-permission-id="${CSS.escape(msg.id)}"]`);
          card?.scrollIntoView({ block: "center" });
          card?.querySelector<HTMLButtonElement>('[aria-label="Your answer"] button')?.focus();
        });
        break;
      default: {
        // A newer host may send types this build does not know: ignore them.
        const unknown: never = msg;
        void unknown;
      }
    }
  }

  /** Put a withdrawn (never sent) prompt back in the composer — rules in
   *  lib/restore.ts. Only on ops, never on `init`. */
  #restoreStoppedPrompt(before: ChatModel, ops: readonly ChatOp[]): void {
    if (!this.here) return; // the page with the chat puts it back
    for (const text of stoppedPromptTexts(before, ops)) {
      // Never clobber what the user typed after pressing Stop.
      this.draft = this.#draft.trim() ? `${text}\n\n${this.#draft}` : text;
    }
  }
}

export const chat = new ChatStore();
