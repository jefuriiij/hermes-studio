// The tabs of the Hermes Studio view and the words of the panel tabs. Pure
// (tested); relative imports so vitest can load it without the Vite aliases.

import type {
  AgentRun,
  LearningView,
  PendingRow,
  SkillRow,
  SkillSource,
} from "../../shared/panels";

export type Tab = "chat" | "learning" | "memory" | "capabilities" | "agents";

export const TABS: readonly { id: Tab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "learning", label: "Learning" },
  { id: "memory", label: "Memory" },
  { id: "capabilities", label: "Capabilities" },
  { id: "agents", label: "Agents" },
];

export const isTab = (v: unknown): v is Tab => TABS.some((t) => t.id === v);

/** Ids tying each tab to its panel (aria-controls / aria-labelledby). */
export const tabId = (t: Tab): string => `hs-tab-${t}`;
export const panelId = (t: Tab): string => `hs-panel-${t}`;

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** "This week Hermes learned 2 skills and improved 4". */
export function weekHeadline(l: LearningView): string {
  const learned = l.newThisWeek;
  const improved = l.improvedThisWeek;
  if (learned && improved) {
    return `This week Hermes learned ${plural(learned, "skill")} and improved ${improved}`;
  }
  if (learned) return `This week Hermes learned ${plural(learned, "skill")}`;
  if (improved) return `This week Hermes improved ${plural(improved, "skill")}`;
  return "Nothing new this week";
}

/** 1834 → "1.8k"; 900 → "900". */
export const kChars = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** "Add to Notes", "Rewrite in About you", "Remove from Notes". */
export function pendingHeading(p: PendingRow): string {
  const file = p.target === "user" ? "About you" : "Notes";
  const head =
    p.action === "add"
      ? `Add to ${file}`
      : p.action === "replace"
        ? `Rewrite in ${file}`
        : p.action === "remove"
          ? `Remove from ${file}`
          : `Change ${file}`;
  return p.more ? `${head} (+${p.more} more)` : head;
}

export type PendingItem =
  | { kind: "one"; row: PendingRow }
  /** Versions of one rewrite (the same entry): pick one, or reject them all. */
  | { kind: "pick"; group: string; rows: PendingRow[] };

/** Proposals as the tab shows them: a group where its newest member is. */
export function pendingItems(rows: readonly PendingRow[]): PendingItem[] {
  const out: PendingItem[] = [];
  const groups = new Map<string, PendingRow[]>();
  for (const row of rows) {
    if (!row.group) {
      out.push({ kind: "one", row });
      continue;
    }
    const members = groups.get(row.group);
    if (members) members.push(row);
    else {
      const fresh = [row];
      groups.set(row.group, fresh);
      out.push({ kind: "pick", group: row.group, rows: fresh });
    }
  }
  // A "group" of one (the others answered meanwhile) is a plain card.
  return out.map((it) =>
    it.kind === "pick" && it.rows.length === 1
      ? { kind: "one", row: it.rows[0] as PendingRow }
      : it,
  );
}

/** What the tab says once Hermes took the answer. */
export function reviewedText(approved: PendingRow | undefined, rejected: number): string {
  if (approved) {
    const file = approved.target === "user" ? "About you" : "Notes";
    return approved.action === "add"
      ? `Added to ${file}.`
      : approved.action === "remove"
        ? `Removed from ${file}.`
        : `Changed in ${file}.`;
  }
  return rejected === 1 ? "Rejected." : `Rejected ${rejected} changes.`;
}

/** "★ Official", "Trusted", "Community". */
export const TRUST_LABEL = {
  official: "★ Official",
  trusted: "Trusted",
  community: "Community",
} as const;

export const SOURCES: readonly { id: SkillSource; label: string }[] = [
  { id: "learned", label: "Learned" },
  { id: "hub", label: "Skills Hub" },
  { id: "local", label: "Your own" },
  { id: "builtin", label: "Built in" },
];

/** Skills of one source (or all) whose name, category or description has the query. */
export function filterSkills(
  skills: readonly SkillRow[],
  source: SkillSource | "all",
  query: string,
): SkillRow[] {
  const q = query.trim().toLowerCase();
  return skills.filter(
    (s) =>
      (source === "all" || s.source === source) &&
      (!q ||
        s.name.toLowerCase().includes(q) ||
        (s.category ?? "").toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q)),
  );
}

/** How a subagent task stands, in a word; `live`: its run has not finished. */
export function taskState(
  status: string | undefined,
  live: boolean,
): "done" | "running" | "failed" | "waiting" | "unknown" {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return live ? "waiting" : "unknown";
}

/** "3 tasks, 1 failed". */
export function runTasks(r: AgentRun): string {
  const failed = r.tasks.filter((t) => t.status === "failed").length;
  return failed
    ? `${plural(r.tasks.length, "task")}, ${failed} failed`
    : plural(r.tasks.length, "task");
}
