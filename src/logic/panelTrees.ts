// The five side panels as plain trees (slice 5). Pure: the host maps nodes to
// VS Code TreeItems and targets to commands. Stable ids, so a refresh keeps
// what the user expanded.

import { dayLabel, durationLabel, relativeTime } from "../shared/time";
import type {
  CuratorView,
  Delegation,
  LearnedSkill,
  McpServer,
  MemoryEntry,
  MemoryLimits,
  PendingMemory,
  SkillInfo,
  SkillSource,
} from "./hermesData";
import { curatorSummaryShort } from "./hermesData";

/** What a click on a node does. */
export type PanelTarget =
  | { kind: "file"; path: string; line?: number }
  /** One ledger event: diff its before/after from Hermes's backups. */
  | { kind: "change"; skill: string; eventId: string }
  | { kind: "allChanges" }
  /** Every change to one skill, in a picker. */
  | { kind: "history"; skill: string }
  | { kind: "session"; id: string }
  /** A staged memory proposal: preview what it would change, as a diff. */
  | { kind: "pending"; id: string };

export interface PanelNode {
  id: string;
  label: string;
  description?: string;
  /** Plain text (the host shows it as-is, never as markdown). */
  tooltip?: string;
  /** A codicon id, and optionally a theme colour id. */
  icon?: { id: string; color?: string };
  open?: PanelTarget;
  children?: PanelNode[];
  /** Initial state of a node with children (the user's choice wins later). */
  expanded?: boolean;
  /** Selects inline actions in package.json (`viewItem == …`). */
  contextValue?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const firstLine = (s: string) =>
  s
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim() ?? "";

const ACTIONS: Record<string, string> = {
  create: "Created",
  patch: "Improved",
  edit: "Rewrote",
  write_file: "Added a file",
  remove_file: "Removed a file",
  archive: "Archived",
  restore: "Restored",
  delete: "Deleted",
  purge: "Purged",
  rollback: "Rolled back",
  "pre-rollback": "Saved before a rollback",
};
export const actionLabel = (action: string) => ACTIONS[action] ?? action;

// ─── Learning ───────────────────────────────────────────────────────────────

export interface LearningInput {
  learning: readonly LearnedSkill[];
  totalChanges: number;
  firstChangeAt?: number;
  now: number;
  /** A session of THIS folder, by id (only those can be opened safely). */
  sessionTitle(id: string): string | undefined;
}

/** A skill Hermes created within this many days counts as "new". */
const NEW_DAYS = 7;
const SHOWN = 15;

export function learningTree(i: LearningInput): PanelNode[] {
  const nodes: PanelNode[] = i.learning.slice(0, SHOWN).map((l) => {
    const fresh =
      l.isNew && l.createdAt !== undefined && i.now - l.createdAt < NEW_DAYS * 86_400_000;
    const when = relativeTime(l.lastChangeAt, i.now);
    const title = l.lastSessionId ? i.sessionTitle(l.lastSessionId) : undefined;
    const tooltip = [
      l.isNew
        ? `Learned by Hermes ${relativeTime(l.createdAt, i.now).toLowerCase()}.`
        : "A skill Hermes improved.",
      `${plural(l.changes, "change")} in the last 30 days; the latest ${when.toLowerCase()}.`,
      title ? `Latest change while working on “${title}”.` : "",
      l.path ? "Click to open its SKILL.md." : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      id: `learn:${l.skill}`,
      label: l.skill,
      description: `${fresh ? "new" : l.isNew ? "learned" : "improved"} · ${plural(l.changes, "change")} · ${when}`,
      tooltip,
      icon: fresh
        ? { id: "sparkle", color: "charts.yellow" }
        : l.isNew
          ? { id: "sparkle" }
          : { id: "edit" },
      ...(l.path ? { open: { kind: "file", path: l.path } as const } : {}),
      expanded: false,
      children: [...l.events]
        .reverse()
        .slice(0, 10)
        .map((e) => ({
          id: `learn:${l.skill}:${e.id}`,
          label: actionLabel(e.action),
          description: relativeTime(e.ts, i.now),
          tooltip:
            e.beforeSha || e.afterSha
              ? "Click to see this change as a diff."
              : "No saved copy of this change.",
          icon: { id: e.action === "create" ? "add" : e.action === "archive" ? "archive" : "diff" },
          open: { kind: "change", skill: l.skill, eventId: e.id },
        })),
    };
  });
  if (i.totalChanges > 0) {
    nodes.push({
      id: "learn:all",
      label: `All ${i.totalChanges} changes`,
      ...(i.firstChangeAt ? { description: `since ${dayLabel(i.firstChangeAt, i.now)}` } : {}),
      icon: { id: "list-unordered" },
      open: { kind: "allChanges" },
    });
  }
  return nodes;
}

/** The badge: skills Hermes changed since the user last looked. */
export function unseenLearning(learning: readonly LearnedSkill[], seenAt: number): number {
  return learning.filter((l) => l.lastChangeAt > seenAt).length;
}

// ─── Curator ────────────────────────────────────────────────────────────────

export function curatorTree(c: CuratorView, now: number): PanelNode[] {
  const state = !c.enabled
    ? "Off"
    : c.paused
      ? "Paused"
      : `On · every ${c.intervalHours % 24 === 0 ? plural(c.intervalHours / 24, "day") : `${c.intervalHours} h`}`;
  const nodes: PanelNode[] = [
    {
      id: "cur:state",
      label: state,
      description: "tidies the skills Hermes learned",
      tooltip:
        "The curator marks unused learned skills stale, then archives them (it never deletes). Merging similar skills uses a model and is off unless you turn it on.",
      icon: {
        id: !c.enabled ? "circle-slash" : c.paused ? "debug-pause" : "pass",
        ...(c.enabled && !c.paused ? { color: "testing.iconPassed" } : {}),
      },
    },
  ];
  if (c.lastRunAt !== undefined) {
    // Forward slash works on Windows too.
    const report = c.reportDir ? `${c.reportDir.replace(/[\\/]+$/, "")}/REPORT.md` : undefined;
    nodes.push({
      id: "cur:last",
      label: `Last run ${dayLabel(c.lastRunAt, now) === "today" ? relativeTime(c.lastRunAt, now) : dayLabel(c.lastRunAt, now)}`,
      ...(curatorSummaryShort(c.summary) ? { description: curatorSummaryShort(c.summary) } : {}),
      ...(c.summary
        ? { tooltip: `${c.summary}${report ? "\nClick to open the report." : ""}` }
        : {}),
      icon: { id: "history" },
      ...(report ? { open: { kind: "file", path: report } as const } : {}),
    });
    if (c.enabled && !c.paused && c.nextRunAt !== undefined) {
      const due = c.nextRunAt <= now;
      nodes.push({
        id: "cur:next",
        label: due ? "Next run: due now" : `Next run from ${dayLabel(c.nextRunAt, now)}`,
        description: `when Hermes has been idle ${plural(c.minIdleHours, "hour")}`,
        tooltip:
          "Hermes starts the curator itself (from its app, gateway or terminal), once it is due and idle. Nothing runs from VS Code.",
        icon: { id: "calendar" },
      });
    }
  } else {
    nodes.push({ id: "cur:never", label: "Not run yet", icon: { id: "history" } });
  }
  nodes.push({
    id: "cur:merge",
    label: "Merging similar skills",
    description: c.consolidate ? "on (uses a model)" : "off",
    icon: { id: "merge" },
  });
  return nodes;
}

// ─── Memory ─────────────────────────────────────────────────────────────────

export interface MemoryInput {
  notes: readonly MemoryEntry[];
  profile: readonly MemoryEntry[];
  notesChars: number;
  profileChars: number;
  limits: MemoryLimits;
  pending: readonly PendingMemory[];
  notesPath: string;
  profilePath: string;
  now: number;
}

const OP_VERB: Record<string, string> = { replace: "Rewrite", remove: "Remove", add: "Add" };

/** "Rewrite “Windows quirk: a…” (+2 more)" — from the operations, not
 *  Hermes's summary ("- replace entry matching '…'"). */
export function pendingLabel(p: PendingMemory): string {
  const first = p.ops[0];
  if (!first) return clip(p.summary || p.action, 90);
  const what = (first.action === "add" ? first.content : first.oldText) ?? "";
  const verb = OP_VERB[first.action] ?? first.action;
  const more = p.ops.length > 1 ? ` (+${p.ops.length - 1} more)` : "";
  return `${verb} “${clip(firstLine(what), 60)}”${more}`;
}

function entryNodes(prefix: string, entries: readonly MemoryEntry[], path: string): PanelNode[] {
  return entries.map((e, n) => ({
    id: `${prefix}:${n}`,
    label: clip(firstLine(e.text), 90),
    tooltip: clip(e.text, 1200),
    open: { kind: "file", path, line: e.line + 1 },
  }));
}

export function memoryTree(m: MemoryInput): PanelNode[] {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const nodes: PanelNode[] = [
    {
      id: "mem:notes",
      label: "Notes",
      description: `${plural(m.notes.length, "entry", "entries")} · ${k(m.notesChars)} / ${k(m.limits.notes)} chars`,
      tooltip: "What Hermes keeps in mind across sessions (MEMORY.md).",
      icon: { id: "note" },
      expanded: false,
      children: entryNodes("mem:n", m.notes, m.notesPath),
    },
    {
      id: "mem:profile",
      label: "About you",
      description: `${plural(m.profile.length, "entry", "entries")} · ${k(m.profileChars)} / ${k(m.limits.profile)} chars`,
      tooltip: "What Hermes knows about you (USER.md).",
      icon: { id: "account" },
      expanded: false,
      children: entryNodes("mem:p", m.profile, m.profilePath),
    },
  ];
  if (m.pending.length > 0) {
    const stale = m.pending.filter((p) => p.stale).length;
    nodes.push({
      id: "mem:pending",
      label: "Waiting for your OK",
      description:
        stale === m.pending.length
          ? `${m.pending.length} · all outdated`
          : stale
            ? `${m.pending.length} · ${stale} outdated`
            : String(m.pending.length),
      tooltip: [
        "Memory rewrites Hermes proposed in a background review. An unattended review may add entries, never replace or remove them, so it parks those changes here for you.",
        "Answer them in the Hermes terminal (the button on this row): /memory pending, /memory approve <id>, /memory reject <id> (or all).",
        stale
          ? `${stale === m.pending.length ? "All" : stale} of these came from an older Hermes that did not pin the entry it reviewed: Hermes will refuse to approve ${stale === 1 ? "it" : "them"}. Click one to see what it wanted to change; reject it and make the change yourself if you still want it.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      icon: { id: "inbox" },
      expanded: false,
      contextValue: "hermesPendingMemory",
      children: m.pending.map((p) => ({
        id: `mem:pend:${p.id}`,
        label: pendingLabel(p),
        description: [
          p.stale ? "can't be approved" : undefined,
          p.target === "user" ? "About you" : "Notes",
          relativeTime(p.createdAt, m.now),
        ]
          .filter(Boolean)
          .join(" · "),
        tooltip: `${clip(p.summary, 1200)}\n\nId: ${p.id}${p.stale ? "\nOutdated: Hermes will refuse to approve it." : ""}\nClick to preview the change.`,
        icon: p.stale ? { id: "warning", color: "editorWarning.foreground" } : { id: "diff" },
        open: { kind: "pending", id: p.id },
      })),
    });
  }
  return nodes;
}

// ─── Capabilities ───────────────────────────────────────────────────────────

const SOURCES: { source: SkillSource; label: string; icon: string }[] = [
  { source: "learned", label: "Learned by Hermes", icon: "sparkle" },
  { source: "hub", label: "From the Skills Hub", icon: "cloud-download" },
  { source: "local", label: "Your own", icon: "person" },
  { source: "builtin", label: "Built in", icon: "package" },
];

export function capabilitiesTree(
  skills: readonly SkillInfo[],
  mcp: readonly McpServer[],
  plugins: { enabled: string[]; disabled: string[]; user: string[] },
): PanelNode[] {
  const groups = SOURCES.map((g) => {
    const list = skills.filter((s) => s.source === g.source);
    return {
      id: `cap:skills:${g.source}`,
      label: g.label,
      description: String(list.length),
      icon: { id: g.icon },
      expanded: false,
      children: list.map((s) => ({
        id: `cap:skill:${s.path}`,
        label: s.name,
        ...(s.category ? { description: s.category } : {}),
        ...(s.description ? { tooltip: clip(s.description, 600) } : {}),
        open: { kind: "file", path: s.path } as const,
      })),
    } satisfies PanelNode;
  }).filter((g) => g.children.length > 0);

  const pluginNames = [...new Set([...plugins.user, ...plugins.enabled])];
  return [
    {
      id: "cap:skills",
      label: "Skills",
      description: String(skills.length),
      icon: { id: "extensions" },
      expanded: true,
      children: groups,
    },
    {
      id: "cap:mcp",
      label: "Connectors (MCP)",
      description: String(mcp.length),
      tooltip: "MCP servers Hermes connects to (config.yaml → mcp_servers).",
      icon: { id: "plug" },
      expanded: mcp.length > 0 && mcp.length <= 6,
      children: mcp.map((s) => ({
        id: `cap:mcp:${s.name}`,
        label: s.name,
        description: `${s.transport}${s.enabled ? "" : " · off"}`,
        icon: {
          id: s.enabled ? "circle-filled" : "circle-slash",
          ...(s.enabled ? { color: "testing.iconPassed" } : {}),
        },
      })),
    },
    {
      id: "cap:plugins",
      label: "Plugins",
      description: pluginNames.length ? String(pluginNames.length) : "none added",
      tooltip: "Plugins you added or switched on. Hermes's own bundled plugins are not listed.",
      icon: { id: "symbol-misc" },
      expanded: false,
      children: pluginNames.map((p) => ({
        id: `cap:plugin:${p}`,
        label: p,
        ...(plugins.disabled.includes(p) ? { description: "off" } : {}),
      })),
    },
  ];
}

// ─── Agents ─────────────────────────────────────────────────────────────────

export function agentsTree(delegations: readonly Delegation[], now: number): PanelNode[] {
  const running = delegations.filter((d) => d.completedAt === undefined);
  const recent = delegations.filter(
    (d) => d.completedAt !== undefined && now - (d.startedAt ?? 0) < 7 * 86_400_000,
  );
  const node = (d: Delegation): PanelNode => {
    // Hermes writes running / completed / failed (tools/delegation_live_log.py).
    const failed = d.tasks.some((t) => t.status === "failed");
    const took =
      d.startedAt !== undefined && d.completedAt !== undefined
        ? durationLabel(d.completedAt - d.startedAt)
        : undefined;
    return {
      id: `agent:${d.id}`,
      label: clip(d.tasks[0]?.goal || d.id, 70),
      description: [plural(d.tasks.length, "task"), took, relativeTime(d.startedAt, now)]
        .filter(Boolean)
        .join(" · "),
      tooltip: d.tasks.map((t, n) => `${n + 1}. ${clip(t.goal, 400)}`).join("\n"),
      icon:
        d.completedAt === undefined
          ? { id: "loading~spin" }
          : failed
            ? { id: "error", color: "testing.iconFailed" }
            : { id: "pass", color: "testing.iconPassed" },
      expanded: false,
      children: d.tasks.map((t, n) => ({
        id: `agent:${d.id}:${n}`,
        label: clip(t.goal || `Task ${n + 1}`, 90),
        ...(t.status ? { description: t.status } : {}),
        tooltip: `${clip(t.goal, 1200)}${t.log ? "\nClick to open its log." : ""}`,
        ...(t.log ? { open: { kind: "file", path: t.log } as const } : {}),
      })),
    };
  };
  return [
    {
      id: "agents:running",
      label: "Running now",
      description: running.length ? String(running.length) : "none",
      tooltip:
        "Subagents Hermes started with delegate_task in the background. A chat's own subagents show as steps in that chat.",
      icon: { id: "run-all" },
      expanded: running.length > 0,
      children: running.map(node),
    },
    {
      id: "agents:recent",
      label: "Recent",
      description: `${recent.length} · last 7 days`,
      icon: { id: "history" },
      expanded: recent.length > 0 && recent.length <= 5,
      children: recent.map(node),
    },
  ];
}
