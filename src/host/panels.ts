// The Hermes panels in the left sidebar (slice 5): Learning, Curator, Memory,
// Capabilities, Agents. Native tree views over Hermes's own files — read-only.
// What each tree contains is decided in logic/panelTrees.ts (pure, tested);
// this file renders it, watches the files, and runs the clicks. The same
// snapshot also feeds the panel tabs in the chat view (logic/panelTabs.ts).

import * as path from "node:path";

import * as vscode from "vscode";

import type { PanelsView } from "../shared/panels";
import { relativeTime } from "../shared/time";
import { buildDiff } from "../logic/diff";
import { buildPanelsView, latestChange } from "../logic/panelTabs";
import {
  actionLabel,
  agentsTree,
  capabilitiesTree,
  curatorTree,
  learningTree,
  memoryTree,
  type PanelNode,
  type PanelTarget,
  unseenLearning,
} from "../logic/panelTrees";
import { type LedgerEvent, previewPending } from "../logic/hermesData";
import { type DiffDocuments, openDiff } from "./diffDocuments";
import { type HermesSnapshot, readBlob, readLedger, readSnapshot } from "./hermesHome";

export const PANEL_IDS = {
  learning: "hermesStudio.learning",
  curator: "hermesStudio.curator",
  memory: "hermesStudio.memory",
  capabilities: "hermesStudio.capabilities",
  agents: "hermesStudio.agents",
} as const;
type Panel = keyof typeof PANEL_IDS;

const OPEN_COMMAND = "hermesStudio.panels.open";
const SEEN_KEY = "hermesStudio.learningSeenAt";
/** Hermes rewrites several files per change (atomic renames): read once after they settle. */
const DEBOUNCE_MS = 800;

class NodeTree implements vscode.TreeDataProvider<PanelNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: PanelNode[] = [];

  set(nodes: PanelNode[]): void {
    this.roots = nodes;
    this.changed.fire();
  }

  getChildren(node?: PanelNode): PanelNode[] {
    return node ? (node.children ?? []) : this.roots;
  }

  getTreeItem(n: PanelNode): vscode.TreeItem {
    const state = n.children?.length
      ? n.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(n.label, state);
    item.id = n.id;
    if (n.description) item.description = n.description;
    // A plain string, never a MarkdownString: memory and skill texts are
    // Hermes's (model-written) and must not render as links or images.
    if (n.tooltip) item.tooltip = n.tooltip;
    if (n.icon) {
      item.iconPath = new vscode.ThemeIcon(
        n.icon.id,
        n.icon.color ? new vscode.ThemeColor(n.icon.color) : undefined,
      );
    }
    if (n.open) item.command = { command: OPEN_COMMAND, title: "Open", arguments: [n.open] };
    if (n.contextValue) item.contextValue = n.contextValue;
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export interface PanelDeps {
  /** A session of this folder by id (only those are safe to open). */
  sessionTitle(id: string): string | undefined;
  openSession(id: string): void;
  diffDocs: DiffDocuments;
  log(line: string): void;
  /** The panel tabs' view, after every read and whenever the badge changes. */
  onView?(view: PanelsView): void;
}

/** Rows of Recent changes that get +/− line counts (the tab shows these). */
const COUNTED = 15;

export class HermesPanels implements vscode.Disposable {
  private readonly trees: Record<Panel, NodeTree> = {
    learning: new NodeTree(),
    curator: new NodeTree(),
    memory: new NodeTree(),
    capabilities: new NodeTree(),
    agents: new NodeTree(),
  };
  private readonly views: Record<Panel, vscode.TreeView<PanelNode>>;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lensChanged = new vscode.EventEmitter<void>();
  private snapshot?: HermesSnapshot;
  private timer?: ReturnType<typeof setTimeout>;
  private reading = false;
  private again = false;
  private pendingNoteShown = false;
  /** The tabs' last view and what its keys open (only these can be opened). */
  private tabView?: PanelsView;
  private targets = new Map<string, PanelTarget>();
  /** A change's +/− lines by ledger event id (a change never changes). */
  private readonly lineCounts = new Map<string, { added: number; removed: number } | null>();
  /** Set by markSeen, so the badge is right before globalState catches up. */
  private seen?: number;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly home: string,
    private readonly deps: PanelDeps,
  ) {
    const make = (p: Panel) =>
      vscode.window.createTreeView(PANEL_IDS[p], {
        treeDataProvider: this.trees[p],
        showCollapseAll: p !== "curator",
      });
    this.views = {
      learning: make("learning"),
      curator: make("curator"),
      memory: make("memory"),
      capabilities: make("capabilities"),
      agents: make("agents"),
    };
    this.disposables.push(
      ...Object.values(this.views),
      ...Object.values(this.trees),
      this.lensChanged,
    );

    // Seen = the Learning view was on screen: its badge (on the activity bar
    // icon) counts what Hermes changed since then.
    this.disposables.push(
      this.views.learning.onDidChangeVisibility((e) => {
        if (e.visible) this.markSeen();
      }),
    );
    for (const v of Object.values(this.views)) {
      this.disposables.push(v.onDidChangeVisibility((e) => e.visible && this.refresh()));
    }

    this.disposables.push(
      vscode.commands.registerCommand(OPEN_COMMAND, (t: PanelTarget) => this.open(t)),
      vscode.commands.registerCommand("hermesStudio.panels.history", (skill?: string) =>
        this.pickChange(skill),
      ),
      vscode.languages.registerCodeLensProvider(
        {
          scheme: "file",
          pattern: new vscode.RelativePattern(vscode.Uri.file(home), "skills/**/SKILL.md"),
        },
        {
          onDidChangeCodeLenses: this.lensChanged.event,
          provideCodeLenses: (doc) => this.lenses(doc),
        },
      ),
    );

    // The files Hermes rewrites when something here changes. Not .usage.json
    // (rewritten on every skill view) and not state.db (every message).
    const base = vscode.Uri.file(home);
    for (const glob of [
      "skills/{.curator_ledger.jsonl,.curator_state,.bundled_manifest}",
      "skills/.hub/lock.json",
      "skills/**/SKILL.md",
      // A new skill folder, or a link to one elsewhere (~/.agents/skills):
      // its SKILL.md then changes outside this folder and never fires above.
      // Not dot-names (.usage.json is rewritten on every skill view).
      "skills/[!.]*",
      "skills/[!.]*/[!.]*",
      "memories/*.md",
      "pending/memory/*.json",
      "cache/delegation/live/*/manifest.json",
      "config.yaml",
    ]) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, glob));
      w.onDidCreate(() => this.refresh());
      w.onDidChange(() => this.refresh());
      w.onDidDelete(() => this.refresh());
      this.disposables.push(w);
    }
    this.refresh();
  }

  /** The memory proposals of the last read (the Memory tab answers only these). */
  pendingIds(): ReadonlySet<string> {
    return new Set(this.snapshot?.memory.pending.map((p) => p.id) ?? []);
  }

  /** Read Hermes's files again (debounced; one read at a time). */
  refresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.read();
    }, DEBOUNCE_MS);
  }

  private async read(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      this.snapshot = await readSnapshot(this.home, Date.now());
      this.render(this.snapshot);
      await this.countLines(this.snapshot);
      this.publishView();
    } catch (e) {
      this.deps.log(`[ext] could not read Hermes's files: ${(e as Error).message}`);
    } finally {
      this.reading = false;
      if (this.again) {
        this.again = false;
        void this.read();
      }
    }
  }

  private render(s: HermesSnapshot): void {
    const now = Date.now();
    if (!s.found) {
      for (const v of Object.values(this.views)) {
        v.message = `Hermes's folder was not found (${s.home}). Set HERMES_HOME if Hermes keeps it elsewhere.`;
      }
      for (const t of Object.values(this.trees)) t.set([]);
      return;
    }
    const title = (id: string) => this.deps.sessionTitle(id);
    this.trees.learning.set(learningTree({ ...s, now, sessionTitle: title }));
    this.views.learning.message = s.learning.length
      ? undefined
      : "Hermes has not learned or changed a skill in the last 30 days.";
    this.trees.curator.set(curatorTree(s.curator, now));
    this.views.curator.message = undefined;
    this.trees.memory.set(memoryTree({ ...s.memory, now }));
    this.views.memory.message = undefined;
    this.trees.capabilities.set(capabilitiesTree(s.skills, s.mcp, s.plugins));
    this.views.capabilities.message = undefined;
    this.trees.agents.set(agentsTree(s.delegations, now));
    this.views.agents.message = undefined;

    if (this.views.learning.visible) this.markSeen();
    else this.updateBadge();
    this.lensChanged.fire();
  }

  private seenAt(): number {
    return this.seen ?? this.context.globalState.get<number>(SEEN_KEY) ?? 0;
  }

  /** The Learning tree or tab is on screen: what Hermes changed so far is seen. */
  markSeen(): void {
    this.seen = Date.now();
    void this.context.globalState.update(SEEN_KEY, this.seen);
    this.views.learning.badge = undefined;
    if (this.tabView?.learning.unseen) this.publishView();
  }

  // ─── the panel tabs in the chat view ──────────────────────────────────────

  /** The tabs' latest view (for a webview that just loaded). */
  get view(): PanelsView | undefined {
    return this.tabView;
  }

  private publishView(): void {
    const s = this.snapshot;
    if (!s) return;
    const { view, targets } = buildPanelsView(s, {
      now: Date.now(),
      seenAt: this.seenAt(),
      sessionTitle: (id) => this.deps.sessionTitle(id),
      lineCounts: (id) => this.lineCounts.get(id) ?? undefined,
    });
    this.tabView = view;
    this.targets = targets;
    this.deps.onView?.(view);
  }

  /** A click in a tab. Only keys of the last view open anything. */
  openKey(key: string): void {
    const t = this.targets.get(key);
    if (t) void this.open(t);
    else this.deps.log("[ext] ignored a panel click that the current view does not offer");
  }

  /** +/− lines of each shown skill's latest change, from Hermes's backups. */
  private async countLines(s: HermesSnapshot): Promise<void> {
    for (const l of s.learning.slice(0, COUNTED)) {
      const e = latestChange(l);
      if (!e || this.lineCounts.has(e.id)) continue;
      const before = e.beforeSha ? await readBlob(this.home, e.beforeSha) : "";
      const after = e.afterSha ? await readBlob(this.home, e.afterSha) : "";
      if (before === undefined || after === undefined) {
        this.lineCounts.set(e.id, null); // pruned from the backups: no counts
        continue;
      }
      const d = buildDiff(e.path ?? "SKILL.md", before, after);
      this.lineCounts.set(e.id, { added: d.added, removed: d.removed });
    }
  }

  private updateBadge(): void {
    const n = this.snapshot ? unseenLearning(this.snapshot.learning, this.seenAt()) : 0;
    this.views.learning.badge = n
      ? {
          value: n,
          tooltip: `Hermes changed ${n === 1 ? "a skill" : `${n} skills`} since you last looked`,
        }
      : undefined;
  }

  // ─── clicks ───────────────────────────────────────────────────────────────

  private async open(t: PanelTarget): Promise<void> {
    switch (t.kind) {
      case "file": {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(t.path));
          const pos = t.line ? new vscode.Position(Math.max(0, t.line - 1), 0) : undefined;
          await vscode.window.showTextDocument(doc, {
            preview: true,
            ...(pos ? { selection: new vscode.Range(pos, pos) } : {}),
          });
        } catch {
          void vscode.window.showInformationMessage(
            "That file is not there any more — Hermes may have moved it.",
          );
        }
        return;
      }
      case "change":
        return this.showChange(t.skill, t.eventId);
      case "allChanges":
        return this.pickChange();
      case "history":
        return this.pickChange(t.skill);
      case "session":
        return this.deps.openSession(t.id);
      case "pending":
        return this.previewPending(t.id);
    }
  }

  /** A memory proposal, as a diff of the file today vs. with it applied. */
  private async previewPending(id: string): Promise<void> {
    const s = this.snapshot;
    const p = s?.memory.pending.find((x) => x.id === id);
    if (!s || !p) return;
    const current = (p.target === "user" ? s.memory.profile : s.memory.notes).map((e) => e.text);
    const { entries, problems } = previewPending(current, p.ops);
    const join = (list: readonly string[]) => `${list.join("\n§\n")}\n`;
    const file = p.target === "user" ? "USER.md" : "MEMORY.md";
    await openDiff(
      this.deps.diffDocs,
      { path: file, oldText: join(current), newText: join(entries) },
      `Hermes proposal ${p.id}: ${file} now ↔ with it applied`,
    );
    // Said once per window: the ⚠ rows already mark outdated proposals, and a
    // toast on every click gets in the way. Real problems are always said.
    const notes: string[] = [];
    if (!this.pendingNoteShown) {
      this.pendingNoteShown = true;
      notes.push(
        p.stale
          ? "Hermes will refuse to approve this one: it came from an older Hermes that did not pin the entry it reviewed. Reject it (/memory reject in the Hermes terminal) and make the change yourself if you want it."
          : "To apply it: /memory approve in the Hermes terminal.",
      );
    }
    notes.push(...problems.map((x) => `Not applicable: ${x}.`));
    if (notes.length) void vscode.window.showInformationMessage(notes.join(" "));
  }

  /** One ledger event as a diff, from Hermes's content-addressed backups. */
  private async showChange(skill: string, eventId: string): Promise<void> {
    const e = (await readLedger(this.home)).find((x) => x.id === eventId);
    if (!e) return;
    const before = e.beforeSha ? await readBlob(this.home, e.beforeSha) : "";
    const after = e.afterSha ? await readBlob(this.home, e.afterSha) : "";
    if (before === undefined || after === undefined || (!e.beforeSha && !e.afterSha)) {
      void vscode.window.showInformationMessage("Hermes kept no copy of this change.");
      return;
    }
    const when = new Date(e.ts).toLocaleString();
    await openDiff(
      this.deps.diffDocs,
      { path: e.path ?? `${skill}/SKILL.md`, oldText: before, newText: after },
      `${skill}: ${actionLabel(e.action).toLowerCase()} by Hermes, ${when}`,
    );
  }

  /** Every change Hermes made to skills (or to one skill), newest first. */
  private async pickChange(skill?: string): Promise<void> {
    const now = Date.now();
    const events = (await readLedger(this.home))
      .filter((e) => !skill || e.skill === skill)
      .reverse();
    type Item = vscode.QuickPickItem & { event: LedgerEvent };
    const items: Item[] = events.map((e) => {
      const title = e.sessionId ? this.deps.sessionTitle(e.sessionId) : undefined;
      return {
        label: `$(${e.action === "create" ? "sparkle" : e.action === "archive" ? "archive" : "edit"}) ${e.skill}`,
        description: `${actionLabel(e.action)} · ${relativeTime(e.ts, now)}`,
        ...(title ? { detail: `while working on “${title}”` } : {}),
        event: e,
      };
    });
    const pick = await vscode.window.showQuickPick(items, {
      title: skill ? `Changes to ${skill}` : "Skill changes by Hermes",
      placeHolder: items.length ? "Pick a change to see it as a diff" : "No changes recorded",
      matchOnDescription: true,
    });
    if (pick) await this.showChange(pick.event.skill, pick.event.id);
  }

  // ─── the banner on a SKILL.md ─────────────────────────────────────────────

  private lenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const s = this.snapshot;
    if (!s || path.basename(doc.uri.fsPath) !== "SKILL.md") return [];
    const skillName = path.basename(path.dirname(doc.uri.fsPath));
    const top = new vscode.Range(0, 0, 0, 0);
    const out: vscode.CodeLens[] = [];
    const l = s.learning.find((x) => x.skill === skillName);
    const now = Date.now();
    if (l) {
      const what = l.isNew
        ? `$(sparkle) Learned by Hermes ${relativeTime(l.createdAt, now).toLowerCase()}`
        : `$(edit) Improved by Hermes · last ${relativeTime(l.lastChangeAt, now).toLowerCase()}`;
      out.push(
        new vscode.CodeLens(top, {
          title: `${what} · ${l.changes === 1 ? "1 change" : `${l.changes} changes`} in 30 days`,
          command: "hermesStudio.panels.history",
          arguments: [skillName],
        }),
      );
      const title = l.lastSessionId ? this.deps.sessionTitle(l.lastSessionId) : undefined;
      if (title && l.lastSessionId) {
        out.push(
          new vscode.CodeLens(top, {
            title: `Open “${title.length > 50 ? `${title.slice(0, 49)}…` : title}”`,
            command: OPEN_COMMAND,
            arguments: [{ kind: "session", id: l.lastSessionId } satisfies PanelTarget],
          }),
        );
      }
    } else {
      out.push(
        new vscode.CodeLens(top, {
          title: "$(history) History",
          command: "hermesStudio.panels.history",
          arguments: [skillName],
        }),
      );
    }
    return out;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
