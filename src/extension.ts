// Hermes Studio — entry point. Glue only: every decision lives in
// src/host/chatController.ts (lifecycle, turns) and src/logic/* (pure rules).

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import * as vscode from "vscode";

import type { WebviewToHost } from "./shared/protocol";
import {
  correctAnthropicUsage,
  limitHitFor,
  providerSlugs,
  usageCheckFor,
} from "./logic/accountUsage";
import { parseContextReport } from "./logic/contextInfo";
import { mentionsSkill } from "./logic/skills";
import { buildChildEnv } from "./logic/env";
import { resolveHermes } from "./logic/resolve";
import { ChatController } from "./host/chatController";
import { ChatViewProvider } from "./host/chatViewProvider";
import { HermesClient } from "./host/hermesClient";
import { DIFF_SCHEME, DiffDocuments, openDiff } from "./host/diffDocuments";
import { hermesHome } from "./host/hermesHome";
import { HermesPanels } from "./host/panels";
import {
  AccountUsageService,
  AnthropicPercentBugCheck,
  hermesUsageRunner,
  runHermes,
} from "./host/accountUsage";
import { EffortService } from "./host/effort";
import { SessionActions } from "./host/sessionActions";
import { MemoryReview } from "./host/memoryReview";
import { SkillsHub } from "./host/skillsHub";
import { AttachmentService } from "./host/attachments";
import { EditorContextService } from "./host/editorContext";
import { FileIndex } from "./host/fileIndex";
import { SessionListService } from "./host/sessionList";
import { Notifier } from "./host/notifier";
import { WindowsToasts } from "./host/windowsToast";
import type { PermissionItem } from "./shared/chat";

let controller: ChatController | undefined;
/**
 * Deliberately NOT in context.subscriptions. VS Code disposes subscriptions as
 * soon as deactivate() starts awaiting, without waiting for it — and a disposed
 * channel throws on every write. The shutdown logs as it goes, so the channel
 * must outlive it: deactivate() disposes it after the shutdown finishes.
 */
let output: vscode.OutputChannel | undefined;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A machine-scoped setting, read from user settings only. The manifest's
 *  `"scope": "machine"` already keeps workspaces out; reading only the global
 *  value makes that hold even for a manifest mistake. */
function machineSetting(key: string): unknown {
  const inspected = vscode.workspace.getConfiguration("hermesStudio").inspect(key);
  return inspected?.globalValue ?? inspected?.defaultValue;
}

function resolveNow() {
  return resolveHermes({
    platform: process.platform,
    setting: String(machineSetting("path") ?? ""),
    env: process.env,
    homedir: homedir(),
    isFile,
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Hermes Studio");
  output = out;
  const stamp = () => new Date().toISOString().slice(11, 23);
  // Never throws: a write racing the channel's disposal is dropped, not fatal.
  const write = (line: string) => {
    try {
      out.appendLine(line);
    } catch {
      // channel already closed
    }
  };
  const log = (line: string) => write(`${stamp()} ${line}`);
  const diffDocs = new DiffDocuments();

  let provider: ChatViewProvider | undefined;
  // Made after the provider (it counts on the view); callbacks only run later.
  let notifier: Notifier | undefined;
  // Made after the provider (it posts to it); messages only arrive after activate.
  let panels: HermesPanels | undefined;

  const ctl = new ChatController({
    folder: () => {
      const f = vscode.workspace.workspaceFolders?.[0];
      return f && f.uri.scheme === "file" ? { path: f.uri.fsPath, name: f.name } : undefined;
    },
    launch: () => {
      const r = resolveNow();
      if (!r.ok) return { ok: false, message: r.message };
      log(`[ext] using ${r.command} (found via ${r.via})`);
      return { ok: true, command: r.command, args: ["acp"], env: buildChildEnv(process.env) };
    },
    createClient: (o) => new HermesClient(o),
    trace: () => machineSetting("trace") === true,
    log,
    onStderrLine: (line) => write(`${stamp()} [hermes] ${line}`),
    // Notifications (host/notifier.ts): only when you are not looking at that
    // chat. They reveal the card — the answer is always given there, next to
    // the diff.
    onPermission: (item) =>
      notifier?.notify({
        kind: "approval",
        sessionId: ctl.model.meta.sessionId ?? "",
        cardId: item.id,
        title: ctl.currentTitle(),
        what: approvalWhat(item),
        background: false,
      }),
    onBackgroundPermission: (item, session) =>
      notifier?.notify({
        kind: "approval",
        sessionId: session.id,
        cardId: item.id,
        title: session.title,
        what: approvalWhat(item),
        background: true,
      }),
    onBackgroundDone: (session, outcome, ms) =>
      notifier?.notify(
        outcome === "done"
          ? { kind: "done", sessionId: session.id, title: session.title, ms, background: true }
          : {
              kind: "stopped",
              sessionId: session.id,
              title: session.title,
              why: "Hermes stopped without finishing",
              background: true,
            },
      ),
    // Queued messages of a chat you left: back in the composer, files in its chips.
    onQueueReturned: (items) => {
      for (const q of items) attachments.restore(q.attachments);
      // A skill typed in the text comes back with it; an old-style one (not
      // in the text) goes in front of it as "/name".
      const text = items
        .map((q) => {
          const missing = (q.skills ?? []).filter((k) => !mentionsSkill(q.text, k));
          return missing.length ? `${missing.map((k) => `/${k}`).join(" ")} ${q.text}` : q.text;
        })
        .join("\n\n");
      provider?.post({ type: "draftBack", text });
    },
    onTurnDone: (d) =>
      notifier?.notify(
        d.why
          ? {
              kind: "stopped",
              sessionId: d.sessionId,
              title: d.title,
              why: d.why,
              background: false,
            }
          : { kind: "done", sessionId: d.sessionId, title: d.title, ms: d.ms, background: false },
      ),
    onBackgroundChange: () => notifier?.changed(),
    now: () => Date.now(),
  });
  controller = ctl;

  const sessions = new SessionListService(
    (cursor) => ctl.listSessions(cursor),
    (list) => provider?.post({ type: "sessions", list }),
  );

  // The composer's "+" (files, selection, problems, git changes, images).
  const attachments = new AttachmentService(
    (items) => provider?.post({ type: "context", items, images: ctl.acceptsImages() }),
    () => ctl.acceptsImages(),
  );

  // The "@" list's workspace paths.
  const files = new FileIndex();

  // The file you are in rides along with each message (a chip in the composer).
  const editorContext = new EditorContextService((file) =>
    provider?.post({ type: "editorContext", file }),
  );
  context.subscriptions.push(editorContext);

  // Short Hermes CLI commands (usage, config) run the resolved executable.
  const hermesCommand = () => {
    const r = resolveNow();
    return r.ok ? { command: r.command, env: buildChildEnv(process.env) } : undefined;
  };

  // Hermes's reasoning effort, in the modes pop-up (a global Hermes setting).
  // Rename / delete from the Sessions pop-up, through `hermes sessions …`.
  const sessionActions = new SessionActions(
    ctl,
    () => {
      const h = hermesCommand();
      return h ? (args) => runHermes(h.command, h.env, args) : undefined;
    },
    (result) => provider?.post({ type: "sessionAction", result }),
    () => void sessions.request(),
    log,
  );

  // The Memory tab's Approve / Reject, by Hermes's own handler (mock board 27).
  const memoryReview = new MemoryReview({
    hermes: () => hermesCommand()?.command,
    run: (command, args, timeoutMs) =>
      runHermes(command, buildChildEnv(process.env), args, timeoutMs),
    pendingIds: () => panels?.pendingIds() ?? new Set(),
    publish: (r) => provider?.post({ type: "memoryReviewed", ...r }),
    refresh: () => panels?.refresh(),
    log,
  });

  // "Get more" skills from the Skills Hub (mock board 28). Plain text out of
  // Rich: no colours, wide lines.
  const skillsHub = new SkillsHub({
    run: () => {
      const h = hermesCommand();
      const env = { ...h?.env, NO_COLOR: "1", TERM: "dumb", COLUMNS: "200" };
      return h ? (args, timeoutMs) => runHermes(h.command, env, args, timeoutMs) : undefined;
    },
    publishResults: (r) => provider?.post({ type: "hubResults", ...r }),
    publishInstalled: (r) => provider?.post({ type: "hubInstalled", ...r }),
    refresh: () => panels?.refresh(),
    log,
    now: () => Date.now(),
  });

  const effort = new EffortService(
    () => {
      const h = hermesCommand();
      return h ? (args) => runHermes(h.command, h.env, args) : undefined;
    },
    (state) => provider?.post({ type: "effort", effort: state }),
    log,
  );

  // Subscription limits in the model menu ("24% used").
  const anthropicBug = new AnthropicPercentBugCheck(hermesCommand, log);
  const accountUsage = new AccountUsageService({
    publish: (usage) => provider?.post({ type: "accountUsage", usage }),
    log,
    now: () => Date.now(),
    runner: () => {
      const h = hermesCommand();
      return h ? hermesUsageRunner(h.command, h.env) : undefined;
    },
    adjust: (slug, usage) =>
      slug === "anthropic" && anthropicBug.present
        ? correctAnthropicUsage(usage, limitHitFor(slug, ctl.model.meta))
        : usage,
  });

  /** Memory proposals are answered in Hermes's own chat (`/memory …` exists
   *  there, not in editor mode): open it in a terminal, and say what to type.
   *  Nothing is typed for the user — rejecting deletes proposals. */
  const reviewMemory = () => {
    const r = resolveNow();
    if (!r.ok) {
      void vscode.commands.executeCommand("workbench.action.openSettings", "hermesStudio.path");
      return;
    }
    vscode.window.createTerminal({ name: "Hermes — memory review", shellPath: r.command }).show();
    void vscode.window.showInformationMessage(
      "In the Hermes terminal: /memory pending lists the proposals; /memory approve <id> applies one; /memory reject <id> (or all) drops them.",
    );
  };

  const runSetup = () => {
    const r = resolveNow();
    if (!r.ok) {
      void vscode.commands.executeCommand("workbench.action.openSettings", "hermesStudio.path");
      return;
    }
    // The resolved exe as the terminal's shell: no PATH lookup, no quoting
    // rules of whatever shell the user's default profile is.
    const terminal = vscode.window.createTerminal({
      name: "Hermes setup",
      shellPath: r.command,
      shellArgs: ["model"],
    });
    terminal.show();
    // Hermes reads its .env only at startup, so the running process cannot
    // see a key `hermes model` just saved: restart it once setup closes.
    const sub = vscode.window.onDidCloseTerminal((t) => {
      if (t !== terminal) return;
      sub.dispose();
      void ctl.restart();
    });
    context.subscriptions.push(sub);
  };

  const onMessage = (m: WebviewToHost) => {
    switch (m.type) {
      case "send": {
        // Taken now (the chips clear as the message goes); given back if the
        // message never reached Hermes.
        const att = attachments.take();
        // The file you are in goes along, read fresh at this moment — not with
        // a slash command: Hermes joins every text block into the command line,
        // so `/model x` would get the file's note as part of its argument.
        // A skill message starts with the skill note, not the "/": it gets it.
        const skills = m.skills ?? [];
        const command = skills.length === 0 && m.text.trimStart().startsWith("/");
        const editor = command ? undefined : editorContext.forSend(att);
        const all = editor ? [...att, editor] : att;
        // Hermes is working: the message waits for the reply to end (mock
        // board 17), with the file you are in now.
        if (ctl.working) {
          ctl.enqueue(m.text, all, skills);
          break;
        }
        void ctl.send(m.text, all, skills).then((sent) => {
          if (!sent) attachments.restore(att);
        });
        break;
      }
      case "queueSendNow":
        void ctl.sendQueuedNow(m.id);
        break;
      case "queueRemove": {
        const q = ctl.removeQueued(m.id);
        if (q && m.restore) attachments.restore(q.attachments);
        break;
      }
      case "fileSearch":
        void files
          .search(m.query)
          .then((items) => provider?.post({ type: "fileResults", seq: m.seq, items }))
          .catch((e: unknown) => log(`[ext] file search failed: ${String(e)}`));
        break;
      case "mentionFile":
        void attachments.addFileByPath(m.path);
        break;
      case "dropUris":
        void attachments.addDropped(m.uris);
        break;
      case "cancel":
        void ctl.stop();
        break;
      case "newChat":
        void ctl.newChat();
        break;
      case "action":
        switch (m.action) {
          case "restart":
            void ctl.restart();
            break;
          case "setup":
            runSetup();
            break;
          case "setPath":
            void vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "hermesStudio.path",
            );
            break;
          case "showLog":
            out.show(true);
            break;
          case "openFolder":
            void vscode.commands.executeCommand("vscode.openFolder");
            break;
        }
        break;
      case "openLink":
        openLink(m.href, log);
        break;
      case "listSessions":
        void sessions.request(m.cursor);
        break;
      case "openSession":
        void ctl.openSaved(m.sessionId);
        break;
      case "setModel":
        void ctl.setModel(m.modelId);
        break;
      case "setMode":
        void ctl.setMode(m.modeId);
        break;
      case "continueWith":
        void ctl.continueWith(m.modelId);
        break;
      case "dismissLimit":
        ctl.dismissLimit();
        break;
      case "permission":
        // False when the card stopped waiting meanwhile: the card already says so.
        ctl.answerPermission(m.id, m.optionId);
        break;
      case "openDiff": {
        const diff = ctl.diffFor(m.id);
        if (diff) void openDiff(diffDocs, diff);
        break;
      }
      case "openFile":
        void openFile(m.path, m.line, log);
        break;
      case "checkPaths": {
        // Relative paths are the workspace folder's, as openFile reads them.
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const known: Record<string, boolean> = {};
        for (const p of m.paths) {
          const full = isAbsolute(p) ? p : root ? resolve(root, p) : undefined;
          known[p] = !!full && isFile(full);
        }
        provider?.post({ type: "paths", known });
        break;
      }
      case "addContext":
        void attachments.add(m.kind);
        break;
      case "removeContext":
        attachments.remove(m.id);
        break;
      case "pasteImage":
        attachments.addImage(m.mimeType, m.data);
        break;
      case "previewImage":
        provider?.post({ type: "imagePreview", id: m.id, image: attachments.image(m.id) ?? null });
        break;
      case "refreshUsage":
        // The bug check first: it decides how an Anthropic 100% reads.
        void anthropicBug
          .update()
          .then(() => accountUsage.refresh(providerSlugs(ctl.model.meta.models ?? [])));
        break;
      case "ready":
        // The provider sent the snapshot; the chips are ours to resend.
        provider?.post({ type: "context", items: attachments.chips, images: ctl.acceptsImages() });
        provider?.post({ type: "accountUsage", usage: accountUsage.snapshot });
        editorContext.republish();
        provider?.post({ type: "effort", effort: effort.snapshot });
        if (panels?.view) provider?.post({ type: "panels", view: panels.view });
        provider?.post({
          type: "background",
          sessions: notifier?.backgroundList() ?? ctl.backgroundSessions(),
        });
        break;
      case "panelOpen":
        panels?.openKey(m.key);
        break;
      case "panelSeen":
        panels?.markSeen();
        break;
      case "refreshPanels":
        panels?.refresh();
        break;
      case "memoryReview":
        void memoryReview.review(m.approve, m.reject);
        break;
      case "hubSearch":
        void skillsHub.search(m.query, m.official, m.seq);
        break;
      case "hubInstall":
        void skillsHub.install(m.identifier);
        break;
      case "renameSession":
        void sessionActions.rename(m.sessionId, m.title);
        break;
      case "deleteSession":
        void sessionActions.delete(m.sessionId);
        break;
      case "toggleEditorContext":
        editorContext.toggle();
        break;
      case "contextInfo":
        void ctl.contextReport().then((text) =>
          provider?.post({
            type: "contextInfo",
            info: text ? (parseContextReport(text) ?? null) : null,
          }),
        );
        break;
      case "compress":
        // A normal message, so the chat shows it and Hermes's answer.
        void ctl.send("/compress");
        break;
      case "refreshEffort":
        void effort.refresh();
        break;
      case "setEffort":
        void effort.set(m.level);
        break;
    }
  };

  provider = new ChatViewProvider(context.extensionUri, ctl, onMessage, log);
  const view = provider;

  // Hermes needs you, finished, or stopped: VS Code's notifications, Windows's,
  // and the count on the view (mock board 16).
  const note = new Notifier({
    chatVisible: () => view.visible,
    goTo: async (sessionId, cardId) => {
      await view.reveal();
      if (sessionId && sessionId !== ctl.model.meta.sessionId) await ctl.openSaved(sessionId);
      if (cardId) await view.showPermission(cardId);
    },
    currentSession: () => ctl.model.meta.sessionId,
    waitingSessions: () => ctl.waitingSessions(),
    background: () => ctl.backgroundSessions(),
    publishBackground: (sessions) => view.post({ type: "background", sessions }),
    setCount: (n, tooltip) => view.setCount(n, tooltip),
    settings: () => ({
      enabled: machineSetting("notifications") !== false,
      windows: machineSetting("windowsNotifications") !== false,
    }),
    link: (query) => `${vscode.env.uriScheme}://${context.extension.id}/show?${query}`,
    logoPath: vscode.Uri.joinPath(context.extensionUri, "resources", "hermes-toast.png").fsPath,
    toasts: new WindowsToasts(vscode.env.appName, log),
    log,
  });
  notifier = note;
  // What you look at is seen: the chat on screen, another session opening.
  const unwatch = ctl.onChange(() => note.looked());
  // The model chip warns before a limit: read the current provider's usage
  // again when a reply ends or the model changes.
  let usageSeen: { busy: boolean; modelId?: string } | undefined;
  const unwatchUsage = ctl.onChange((_ops, m) => {
    const seen = { busy: m.meta.busy, ...(m.meta.modelId ? { modelId: m.meta.modelId } : {}) };
    const slug = usageCheckFor(usageSeen, seen);
    usageSeen = seen;
    if (!slug) return;
    const force = m.meta.limit?.kind === "limit";
    void anthropicBug.update().then(() => accountUsage.refresh([slug], force));
  });

  // Read-only views over Hermes's own files (learning, curator, memory, …),
  // as trees in the left sidebar and as tabs in the chat view.
  const hermesPanels = new HermesPanels(
    context,
    hermesHome(process.env, process.platform, homedir()),
    {
      sessionTitle: (id) => ctl.sessionTitle(id),
      openSession: (id) => {
        void provider?.reveal();
        void ctl.openSaved(id);
      },
      diffDocs,
      log,
      onView: (view) => provider?.post({ type: "panels", view }),
    },
  );
  panels = hermesPanels;

  context.subscriptions.push(
    // `out` is not here on purpose — see `output` above.
    provider,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffDocs),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      // A turn streaming while the view is hidden must not be lost.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // With the chat in an editor tab, VS Code restores the tab on reload.
    vscode.window.registerWebviewPanelSerializer(ChatViewProvider.editorType, provider),
    note,
    { dispose: unwatch },
    { dispose: unwatchUsage },
    provider.onDidChangeVisible(() => note.looked()),
    // A click on a Windows notification: vscode://<this extension>/show?…
    vscode.window.registerUriHandler({ handleUri: (uri) => note.handleUri(uri) }),
    vscode.commands.registerCommand("hermesStudio.openChat", () => provider?.reveal()),
    vscode.commands.registerCommand("hermesStudio.openChatInEditor", () =>
      provider?.openInEditor(),
    ),
    vscode.commands.registerCommand("hermesStudio.moveChatToSidebar", () => provider?.moveToSide()),
    vscode.commands.registerCommand("hermesStudio.newChat", () => {
      // From the side bar's title bar while the chat is in a background tab
      // (or from the Command Palette): show the new chat.
      if (!provider?.visible) void provider?.reveal();
      return ctl.newChat();
    }),
    vscode.commands.registerCommand("hermesStudio.showSessions", () => provider?.showSessions()),
    hermesPanels,
    vscode.commands.registerCommand("hermesStudio.refreshPanels", () => hermesPanels.refresh()),
    vscode.commands.registerCommand("hermesStudio.reviewMemory", reviewMemory),
    vscode.commands.registerCommand("hermesStudio.showSkillChanges", () =>
      vscode.commands.executeCommand("hermesStudio.panels.history"),
    ),
    vscode.commands.registerCommand("hermesStudio.restart", () => ctl.restart()),
    vscode.commands.registerCommand("hermesStudio.showLog", () => out.show(true)),
    // After fixing the path (or installing Hermes), retry without making the
    // user find the ↻ button. Only from a state that is waiting for a fix: a
    // setting edit must never kill a healthy session or a running turn.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("hermesStudio.path")) return;
      // (From `idle` nothing to do: the next start reads the new path anyway.)
      const s = ctl.model.meta.connection.state;
      if (s === "notFound" || s === "error") void ctl.restart();
    }),
    { dispose: () => void ctl.shutdown() },
  );
}

/** What an approval card is about, in a line: "Edit: src/auth/oauth.ts". */
function approvalWhat(item: PermissionItem): string {
  return item.target ? `${item.heading}: ${item.target}` : item.heading;
}

/** Open only web links, and only after parsing — the href came from model output. */
function openLink(href: string, log: (line: string) => void): void {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    log(`[ext] ignored an unparseable link`);
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    log(`[ext] ignored a ${url.protocol} link`);
    return;
  }
  void vscode.env.openExternal(vscode.Uri.parse(url.toString()));
}

/**
 * Open a file Hermes named (a card's target, a step's location). Relative
 * paths are the workspace folder's. Only existing files, and only on a click:
 * opening shows the file to the user in their own editor, nothing more.
 */
async function openFile(
  p: string,
  line: number | undefined,
  log: (line: string) => void,
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const full = isAbsolute(p) ? p : root ? resolve(root, p) : undefined;
  if (!full || !isFile(full)) {
    log("[ext] ignored a link to a file that does not exist");
    return;
  }
  const pos = line ? new vscode.Position(line - 1, 0) : undefined;
  await vscode.window.showTextDocument(vscode.Uri.file(full), {
    preview: true,
    ...(pos ? { selection: new vscode.Range(pos, pos) } : {}),
  });
}

export async function deactivate(): Promise<void> {
  try {
    await controller?.shutdown();
  } finally {
    // Only now: the shutdown above logs until its last step.
    output?.dispose();
    output = undefined;
  }
}
