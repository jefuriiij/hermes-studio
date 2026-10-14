// The Hermes panels as tabs in the chat view (plan-panel-tabs.md). Types only:
// the host builds a PanelsView from Hermes's files (logic/panelTabs.ts) and
// the webview renders it. Times are epoch ms, worded by the webview with its
// own clock. A `key` names something a click opens; the webview sends it back
// as-is (`panelOpen`) and the host opens only keys of the view it last sent.

export interface PanelsView {
  /** False: Hermes's folder was not found (`home` says where we looked). */
  found: boolean;
  home: string;
  learning: LearningView;
  curator: CuratorCard;
  memory: MemoryView;
  capabilities: CapabilitiesView;
  agents: AgentsView;
}

export interface LearningView {
  /** Skills Hermes created in the last 7 days. */
  newThisWeek: number;
  /** Other skills Hermes changed in the last 7 days. */
  improvedThisWeek: number;
  /** Every skill Hermes made itself, and every skill it can use. */
  learnedTotal: number;
  skillsTotal: number;
  /** Skills changed since the user last looked (shared with the tree's badge). */
  unseen: number;
  /** The last 30 days, newest first. */
  items: LearningRow[];
  totalChanges: number;
  firstChangeAt?: number;
  /** Every change ever recorded, in a picker. */
  allChanges?: string;
}

export interface LearningRow {
  skill: string;
  /** new: created in the last 7 days; learned: created earlier in the 30. */
  kind: "new" | "learned" | "improved";
  description?: string;
  lastChangeAt: number;
  changes: number;
  /** Open its SKILL.md. */
  open?: string;
  /** The latest change as a diff, with its line counts once known. */
  diff?: { key: string; added?: number; removed?: number };
  /** Every change to this skill, in a picker. */
  history: string;
  /** The chat the latest change came from, when it is one of this folder's. */
  session?: { key: string; title: string };
}

export interface CuratorCard {
  state: "on" | "paused" | "off";
  /** "weekly", "daily", "every 3 days", "every 12 h". */
  every: string;
  lastRunAt?: number;
  /** "1 marked stale". */
  summary?: string;
  nextRunAt?: number;
  minIdleHours: number;
  /** Its last REPORT.md. */
  report?: string;
  consolidate: boolean;
}

export interface MemoryView {
  notes: MemoryFile;
  profile: MemoryFile;
  pending: PendingRow[];
}

export interface MemoryFile {
  /** Model-written text: render as text, never as HTML. */
  entries: { text: string; key: string }[];
  chars: number;
  limit: number;
  /** The file itself. */
  open: string;
}

export interface PendingRow {
  id: string;
  /** The first operation's verb. */
  action: "add" | "replace" | "remove" | "other";
  target: "memory" | "user";
  text: string;
  /** Further operations in the same proposal. */
  more: number;
  createdAt?: number;
  /** Hermes will refuse to approve it: no pinned entry (an older Hermes), or
   *  `changed`. */
  stale: boolean;
  /** The entry it was made for is no longer in the file as Hermes saw it. */
  changed?: boolean;
  /** Preview it as a diff. */
  key: string;
  /** The entry a replace/remove would change, as it reads now. */
  replaces?: string;
  /** Proposals that rewrite the SAME entry share this: once one is approved,
   *  Hermes can't apply the others, so the tab offers them as one choice. */
  group?: string;
}

/** A skill on the Skills Hub (`hermes skills search --json`). */
export interface HubSkill {
  name: string;
  identifier: string;
  /** "official", "github", "skills.sh", … */
  source: string;
  /** official: Nous Research's own; trusted: a trusted repo; else community. */
  trust: "official" | "trusted" | "community";
  description?: string;
}

export type SkillSource = "learned" | "hub" | "builtin" | "local";

export interface CapabilitiesView {
  skills: SkillRow[];
  mcp: { name: string; transport: string; enabled: boolean }[];
  plugins: { name: string; enabled: boolean }[];
}

export interface SkillRow {
  name: string;
  category?: string;
  description?: string;
  source: SkillSource;
  key: string;
}

export interface AgentsView {
  running: AgentRun[];
  /** Finished, started in the last 7 days. */
  recent: AgentRun[];
}

export interface AgentRun {
  id: string;
  goal: string;
  startedAt?: number;
  completedAt?: number;
  failed: boolean;
  /** Hermes writes running / completed / failed. Each opens its log. */
  tasks: { goal: string; status?: string; key?: string }[];
}
