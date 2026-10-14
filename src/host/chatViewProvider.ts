// The chat's webviews: the side bar view, and an editor tab when the chat is
// opened there. HTML shell, CSP, and the message bridge.
//
// There is one chat. It lives in the editor tab while that tab exists, and in
// the side bar otherwise (logic/chatPlace.ts). Both pages get the same model
// and the same updates; the side bar, while the chat is in the tab, shows
// where it went, and its panel tabs keep working.
//
// A webview is a render target that can be destroyed at any time (moved,
// Reload Webviews). On every load it posts `ready`; the host answers with a
// full `init` snapshot and from then on sends batched ops. Ops produced while
// a page is not ready are dropped for it, not queued: they are already inside
// its next snapshot, and replaying them on top of it would duplicate streamed
// text.

import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import { coalesceOps, type ChatOp } from "../shared/chat";
import { type HostToWebview, isWebviewToHost, type WebviewToHost } from "../shared/protocol";
import { acceptedAway } from "../logic/chatPlace";
import { buildHtml } from "../logic/html";
import type { ChatController } from "./chatController";

/** A streamed reply produces dozens of tiny appends per second; post at most
 *  this often, coalesced. */
const FLUSH_MS = 30;

interface Surface {
  readonly place: "side" | "editor";
  readonly webview: vscode.Webview;
  ready: boolean;
  /** Ops for this page since its last flush. */
  pending: ChatOp[];
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer {
  static readonly viewType = "hermesStudio.chat";
  /** The editor tab's webview type (and its serializer's). */
  static readonly editorType = "hermesStudio.chatEditor";

  private view?: vscode.WebviewView;
  private side?: Surface;
  private panel?: vscode.WebviewPanel;
  private editor?: Surface;
  private flushTimer?: ReturnType<typeof setTimeout>;
  /** Open Chat asked for focus before the chat's page had loaded (its first
   *  open): deliver it right after the `init` snapshot. */
  private focusPending = false;
  /** The same for the History button. */
  private sessionsPending = false;
  /** The composer's text as the chat's page last reported it, so it moves
   *  with the chat. Undefined until a page reports one. */
  private draft?: { text: string; skill?: string };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly visibility = new vscode.EventEmitter<void>();
  /** The chat came on screen or went off it (either page, or it moved). */
  readonly onDidChangeVisible = this.visibility.event;
  /** Chats that need you (notifier.ts): the view's badge, the tab's icon. */
  private count = 0;
  private countTip = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
    private readonly onMessage: (m: WebviewToHost) => void,
    private readonly log: (line: string) => void,
  ) {
    const unsubscribe = controller.onChange((ops) => this.queue(ops));
    this.disposables.push({ dispose: unsubscribe }, this.visibility);
  }

  /** The count of chats that need you: a badge on the view, and a marked
   *  icon on the editor tab (a tab has no badge). */
  setCount(n: number, tooltip: string): void {
    this.count = n;
    this.countTip = tooltip;
    if (this.view) this.view.badge = n > 0 ? { value: n, tooltip } : undefined;
    this.tabIcon();
  }

  private tabIcon(): void {
    if (!this.panel) return;
    const file = this.count > 0 ? "hermes-button-alert.svg" : "hermes-button.svg";
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "resources", file);
  }

  private get root(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
  }

  /** The page the chat lives in: the editor tab while it exists. */
  private get home(): Surface | undefined {
    return this.panel ? this.editor : this.side;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const surface = this.attach("side", view.webview);
    this.side = surface;
    view.onDidChangeVisibility(() => {
      if (view.visible) this.controller.viewVisible();
      this.visibility.fire();
    });
    if (this.count > 0) view.badge = { value: this.count, tooltip: this.countTip };
    view.onDidDispose(() => {
      if (this.view !== view) return;
      this.view = undefined;
      this.side = undefined;
      if (!this.panel) {
        this.focusPending = false;
        this.sessionsPending = false;
      }
    });
    if (view.visible) this.controller.viewVisible();
  }

  /** A window reload with the chat in an editor tab: VS Code restores the tab. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    this.adopt(panel);
  }

  /** Move the chat into an editor tab (or bring its tab to the front). */
  openInEditor(): void {
    if (this.panel) {
      void this.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.editorType,
      "Hermes Studio",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      // Kept alive in a background tab, like the side bar view: its scroll
      // position and a streaming reply carry on.
      { enableScripts: true, localResourceRoots: [this.root], retainContextWhenHidden: true },
    );
    this.focusPending = true;
    this.adopt(panel);
  }

  /** Close the editor tab: the chat goes back to the side bar, on screen. */
  async moveToSide(): Promise<void> {
    const panel = this.panel;
    if (panel) {
      this.release(panel);
      panel.dispose();
    }
    await this.reveal();
  }

  private adopt(panel: vscode.WebviewPanel): void {
    if (this.panel) {
      // One chat, one tab: a second one (restored twice) goes.
      panel.dispose();
      return;
    }
    this.panel = panel;
    this.tabIcon();
    this.editor = this.attach("editor", panel.webview);
    panel.onDidChangeViewState(() => {
      if (panel.visible) this.controller.viewVisible();
      this.visibility.fire();
    });
    panel.onDidDispose(() => this.release(panel));
    this.placeChanged();
    this.visibility.fire();
    if (panel.visible) this.controller.viewVisible();
  }

  /** The tab closed (or is closing): the chat is the side bar's again. */
  private release(panel: vscode.WebviewPanel): void {
    if (this.panel !== panel) return;
    this.panel = undefined;
    this.editor = undefined;
    this.placeChanged();
    this.visibility.fire();
  }

  private attach(place: Surface["place"], webview: vscode.Webview): Surface {
    const surface: Surface = { place, webview, ready: false, pending: [] };
    const root = this.root;
    webview.options = { enableScripts: true, localResourceRoots: [root] };
    // Listen before setting the HTML so the first `ready` cannot be missed.
    webview.onDidReceiveMessage((m: unknown) => this.receive(surface, m));
    webview.html = buildHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString("base64"),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(root, "webview.js")).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(root, "webview.css")).toString(),
      place,
    });
    return surface;
  }

  /** Tell both pages where the chat is now, and hand the draft over. */
  private placeChanged(): void {
    const inEditor = this.panel !== undefined;
    void vscode.commands.executeCommand("setContext", "hermesStudio.chatInEditor", inEditor);
    const home = this.home;
    for (const s of [this.side, this.editor]) {
      if (s?.ready)
        void s.webview.postMessage({ type: "chatPlace", here: s === home } satisfies HostToWebview);
    }
    // The page the chat left sends its last text as it goes (see `draft` in
    // receive); this is the copy from before.
    if (home?.ready && this.draft) this.postTo(home, { type: "takeDraft", ...this.draft });
  }

  /** Post a one-off message (not a model change) to every page listening. */
  post(msg: HostToWebview): void {
    for (const s of [this.side, this.editor]) {
      if (s?.ready) void s.webview.postMessage(msg);
    }
  }

  private postTo(s: Surface | undefined, msg: HostToWebview): void {
    if (s?.ready) void s.webview.postMessage(msg);
  }

  /** Show the chat where it lives. Neither way waits for the page's script to
   *  run, so on the first open the page is not listening yet. */
  private async showHome(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    await vscode.commands.executeCommand("workbench.view.extension.hermes-studio");
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  }

  /** Reveal the chat and focus the composer. */
  async reveal(): Promise<void> {
    await this.showHome();
    const home = this.home;
    if (home?.ready) this.postTo(home, { type: "focusComposer" });
    else this.focusPending = true;
  }

  /** The chat is on screen (not collapsed, not another tab). */
  get visible(): boolean {
    return this.panel ? this.panel.visible : this.view?.visible === true;
  }

  /** Reveal the chat and put focus on a waiting approval card's Deny button. */
  async showPermission(id: string): Promise<void> {
    await this.showHome();
    // The snapshot on `ready` carries the card; focusing it needs the page up.
    this.postTo(this.home, { type: "focusPermission", id });
  }

  /** Reveal the chat with its Sessions pop-up. */
  async showSessions(): Promise<void> {
    await this.showHome();
    const home = this.home;
    if (home?.ready) this.postTo(home, { type: "showSessions" });
    else this.sessionsPending = true;
  }

  private receive(surface: Surface, m: unknown): void {
    if (surface !== this.side && surface !== this.editor) return; // a page that was replaced
    // The webview renders model output; treat what it sends as untrusted.
    if (!isWebviewToHost(m)) {
      this.log("[ext] ignored a malformed message from the webview");
      return;
    }
    const home = surface === this.home;
    if (!home && !acceptedAway(m.type)) {
      this.log(`[ext] ignored "${m.type}" from the side bar: the chat is in the editor tab`);
      return;
    }
    switch (m.type) {
      case "ready":
        surface.ready = true;
        surface.pending = [];
        // Where the chat is first, so the side bar never flashes the chat.
        void surface.webview.postMessage({ type: "chatPlace", here: home } satisfies HostToWebview);
        void surface.webview.postMessage({
          type: "init",
          model: this.controller.model,
        } satisfies HostToWebview);
        if (home) {
          if (this.draft) this.postTo(surface, { type: "takeDraft", ...this.draft });
          if (this.focusPending) {
            this.focusPending = false;
            this.postTo(surface, { type: "focusComposer" });
          }
          if (this.sessionsPending) {
            this.sessionsPending = false;
            this.postTo(surface, { type: "showSessions" });
          }
        }
        // After the snapshot, so a listener can post its own state (the "+" chips).
        this.onMessage(m);
        return;
      case "draft":
        this.draft = { text: m.text, ...(m.skill ? { skill: m.skill } : {}) };
        // The last keys from the page the chat just left: pass them on.
        if (!home) this.postTo(this.home, { type: "takeDraft", ...this.draft });
        return;
      case "showChat":
        void this.reveal();
        return;
      case "moveChatHere":
        if (surface.place === "side") void this.moveToSide();
        return;
      default:
        this.onMessage(m);
    }
  }

  private queue(ops: ChatOp[]): void {
    let any = false;
    for (const s of [this.side, this.editor]) {
      if (!s?.ready) continue; // its next `init` carries them
      s.pending.push(...ops);
      any = true;
    }
    if (any) this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    this.flushTimer = undefined;
    for (const s of [this.side, this.editor]) {
      if (!s) continue;
      const pending = s.pending;
      s.pending = [];
      if (!s.ready || pending.length === 0) continue;
      void s.webview.postMessage({
        type: "ops",
        ops: coalesceOps(pending),
      } satisfies HostToWebview);
    }
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const d of this.disposables) d.dispose();
    // The editor tab is not closed here: VS Code restores it with the window.
  }
}
