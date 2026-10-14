// Tells you when Hermes needs you, finished, or stopped (mock board 16):
// VS Code's own notification while the chat is not on screen, a Windows one
// while VS Code is not the front window, and a count on the Hermes Studio
// view. What to say and when: logic/notify.ts.
//
// A notification never answers an approval. Show / Open, the Windows toast's
// click and its vscode:// link only bring you to the chat and its card.

import { pathToFileURL } from "node:url";

import * as vscode from "vscode";

import { type Attention, channels, vscodeMessage, windowsMessage } from "../logic/notify";
import type { BackgroundSession } from "../shared/protocol";
import type { WindowsToasts } from "./windowsToast";

export interface NotifierDeps {
  /** The chat is on screen (the side bar view, or its editor tab). */
  chatVisible(): boolean;
  /** Bring the chat to the front on this session, and focus a card in it. */
  goTo(sessionId: string, cardId?: string): Promise<void>;
  /** The session the chat on screen shows. */
  currentSession(): string | undefined;
  /** Sessions with an approval card waiting: the one on screen and the
   *  chats working in the background. */
  waitingSessions(): string[];
  /** The chats working in the background, as the controller has them. */
  background(): BackgroundSession[];
  /** The Sessions pop-up's marks: working, waiting, and finished / stopped. */
  publishBackground(list: BackgroundSession[]): void;
  /** The count on the view (and the editor tab's icon). */
  setCount(count: number, tooltip: string): void;
  settings(): { enabled: boolean; windows: boolean };
  /** A vscode:// link back to this extension: `/show?session=…&card=…`. */
  link(query: string): string;
  /** The PNG the Windows notification shows at the left. */
  logoPath: string;
  toasts: WindowsToasts;
  log(line: string): void;
}

export class Notifier implements vscode.Disposable {
  /** Chats that finished or stopped while you were not looking at them. */
  private readonly unseen = new Map<string, { title: string; state: "done" | "stopped" }>();
  /** Sessions a notification was about: the only ones a vscode:// link may open. */
  private readonly told = new Set<string>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly deps: NotifierDeps) {
    this.subs.push(vscode.window.onDidChangeWindowState(() => this.looked()));
  }

  private get focused(): boolean {
    return vscode.window.state.focused;
  }

  notify(a: Attention): void {
    const s = this.deps.settings();
    const c = channels(
      a,
      { chatVisible: this.deps.chatVisible(), windowFocused: this.focused },
      { enabled: s.enabled, windows: s.windows && this.deps.toasts.available },
    );
    this.told.add(a.sessionId);
    if (c.unseen && a.kind !== "approval") {
      this.unseen.set(a.sessionId, {
        title: a.title,
        state: a.kind === "done" ? "done" : "stopped",
      });
    }
    // An approval counts too, from the controller's waiting cards.
    this.refresh();
    const card = a.kind === "approval" ? a.cardId : undefined;
    if (c.vscode) {
      const m = vscodeMessage(a);
      const show =
        m.level === "warning"
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
      // Never awaited: a notification may never settle.
      void show(m.text, m.action).then((pick) => {
        if (pick) void this.deps.goTo(a.sessionId, card);
      });
    }
    if (c.windows) {
      const m = windowsMessage(a);
      const q = new URLSearchParams({ session: a.sessionId, ...(card ? { card } : {}) });
      void this.deps.toasts.show(a.kind, a.sessionId, {
        ...m,
        launch: this.deps.link(q.toString()),
        logo: pathToFileURL(this.deps.logoPath).href,
      });
    }
  }

  /** The controller's background chats changed; an approval appeared or went. */
  changed(): void {
    this.refresh();
  }

  /** The chat came on screen, VS Code came to the front, another session
   *  opened, or the chat changed (a card appeared or was answered): what you
   *  now see is seen, and the count follows. */
  looked(): void {
    const id = this.deps.currentSession();
    if (id && this.deps.chatVisible() && this.focused) this.unseen.delete(id);
    this.refresh();
  }

  /** The Sessions pop-up's marks: the controller's, plus finished / stopped. */
  backgroundList(): BackgroundSession[] {
    const list = this.deps.background();
    const busy = new Set(list.map((b) => b.id));
    for (const [id, u] of this.unseen) {
      if (!busy.has(id)) list.push({ id, title: u.title, state: u.state });
    }
    return list;
  }

  private lastKey = "";
  private refresh(): void {
    const list = this.backgroundList();
    const needs = new Set([...this.deps.waitingSessions(), ...this.unseen.keys()]);
    const n = needs.size;
    const key = `${n}|${JSON.stringify(list)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.deps.publishBackground(list);
    this.deps.setCount(n, n === 1 ? "1 chat needs you" : `${n} chats need you`);
  }

  /** A click on a Windows notification: `vscode://<extension>/show?session=…&card=…`. */
  handleUri(uri: vscode.Uri): void {
    if (uri.path !== "/show") return;
    const q = new URLSearchParams(uri.query);
    const session = q.get("session") ?? "";
    const card = q.get("card") ?? undefined;
    // Any web page can open a vscode:// link: only ever SHOW, and only a
    // session a notification was about. Never answer anything.
    if (!this.told.has(session)) {
      void this.deps.goTo(this.deps.currentSession() ?? "");
      return;
    }
    void this.deps.goTo(session, card && card.length <= 256 ? card : undefined);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
