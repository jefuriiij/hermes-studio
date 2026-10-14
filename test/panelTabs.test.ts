import { describe, expect, it } from "vitest";

import type { LearnedSkill, LedgerEvent } from "../src/logic/hermesData";
import {
  buildPanelsView,
  latestChange,
  type PanelsContext,
  type PanelsInput,
  panelKey,
} from "../src/logic/panelTabs";
import type { LearningView, PendingRow, SkillRow } from "../src/shared/panels";
import { isWebviewToHost } from "../src/shared/protocol";
import {
  filterSkills,
  isTab,
  kChars,
  pendingHeading,
  pendingItems,
  reviewedText,
  runTasks,
  taskState,
  weekHeadline,
} from "../src/webview/lib/panels";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => NOW - days * DAY;

const ev = (id: string, days: number, action: string, sha?: string): LedgerEvent => ({
  id,
  ts: ago(days),
  actor: "curator",
  action,
  skill: "x",
  ...(sha ? { afterSha: sha } : {}),
});

function skill(
  name: string,
  events: LedgerEvent[],
  extra: Partial<LearnedSkill> = {},
): LearnedSkill {
  const created = events.find((e) => e.action === "create");
  const last = events[events.length - 1] as LedgerEvent;
  return {
    skill: name,
    isNew: created !== undefined,
    ...(created ? { createdAt: created.ts } : {}),
    lastChangeAt: last.ts,
    changes: events.length,
    path: `C:/h/skills/dev/${name}/SKILL.md`,
    events: events.map((e) => ({ ...e, skill: name })),
    ...extra,
  };
}

function input(over: Partial<PanelsInput> = {}): PanelsInput {
  return {
    home: "C:/h",
    found: true,
    learning: [
      // Created 2 days ago, then patched: new this week.
      skill(
        "win-quoting",
        [ev("a1", 2, "create", "b".repeat(64)), ev("a2", 1, "patch", "c".repeat(64))],
        {
          lastSessionId: "sess-2",
        },
      ),
      // Only patched, 3 days ago: improved this week.
      skill("svelte5", [ev("a3", 3, "patch", "d".repeat(64))]),
      // Created 12 days ago: learned, but not this week.
      skill("old-new", [ev("a4", 12, "create")]),
      // Patched 20 days ago: in the 30 days, not this week.
      skill("older", [ev("a5", 20, "patch")]),
    ],
    totalChanges: 42,
    firstChangeAt: ago(60),
    curator: {
      enabled: true,
      paused: false,
      consolidate: false,
      lastRunAt: ago(4),
      summary: "auto: 1 marked stale; llm: skipped (consolidation off)",
      runCount: 3,
      nextRunAt: ago(-3),
      intervalHours: 168,
      minIdleHours: 2,
      reportDir: "C:\\h\\logs\\curator\\20260923\\",
    },
    memory: {
      notes: [
        { text: "Synthra ships to npm.", line: 0 },
        { text: "Never open auth.json.\nSecond line.", line: 2 },
      ],
      profile: [{ text: "Senior developer.", line: 0 }],
      notesChars: 1800,
      profileChars: 900,
      limits: { notes: 2200, profile: 1375 },
      pending: [
        {
          id: "p1",
          action: "add",
          summary: "- add entry",
          target: "memory",
          createdAt: ago(0.1),
          ops: [{ action: "add", content: "Hermes Studio moved to the laptop." }],
          stale: false,
        },
        {
          id: "p2",
          action: "replace",
          summary: "- replace entry matching 'short'",
          target: "user",
          ops: [
            { action: "replace", oldText: "short", content: "Prefers short replies." },
            { action: "remove", oldText: "long" },
          ],
          stale: true,
        },
      ],
      notesPath: "C:/h/memories/MEMORY.md",
      profilePath: "C:/h/memories/USER.md",
    },
    skills: [
      {
        name: "win-quoting",
        description: "Quote Windows paths.",
        category: "dev",
        path: "C:/h/skills/dev/win-quoting/SKILL.md",
        source: "learned",
      },
      { name: "old-new", path: "C:/h/skills/old-new/SKILL.md", source: "learned" },
      { name: "pdf", path: "C:/h/skills/pdf/SKILL.md", source: "builtin" },
    ],
    mcp: [{ name: "playwright", transport: "stdio · npx", enabled: true }],
    plugins: { enabled: ["kanban"], disabled: ["kanban", "old"], user: ["mine", "old"] },
    delegations: [
      {
        id: "deleg_run",
        startedAt: ago(0.01),
        tasks: [
          { goal: "Read the Codex usage response", status: "running", log: "C:/h/cache/t1.log" },
          { goal: "" },
        ],
      },
      {
        id: "deleg_done",
        startedAt: ago(2),
        completedAt: ago(2) + 180_000,
        tasks: [{ goal: "Research ACP resume", status: "completed" }],
      },
      {
        id: "deleg_failed",
        startedAt: ago(3),
        completedAt: ago(3) + 60_000,
        tasks: [
          { goal: "Find the fix PRs", status: "completed" },
          { goal: "Read them", status: "failed" },
        ],
      },
      { id: "deleg_old", startedAt: ago(9), completedAt: ago(9) + 1000, tasks: [] },
    ],
    ...over,
  };
}

const ctx = (over: Partial<PanelsContext> = {}): PanelsContext => ({
  now: NOW,
  seenAt: ago(2.5),
  sessionTitle: (id) => (id === "sess-2" ? "Fix the login redirect" : undefined),
  ...over,
});

describe("buildPanelsView — Learning", () => {
  it("counts this week, the totals and what changed since the user looked", () => {
    const { view } = buildPanelsView(input(), ctx());
    expect(view.learning).toMatchObject({
      newThisWeek: 1,
      improvedThisWeek: 1,
      learnedTotal: 2,
      skillsTotal: 3,
      // win-quoting (1 day ago) is after seenAt; svelte5 (3 days) is not.
      unseen: 1,
      totalChanges: 42,
      firstChangeAt: ago(60),
    });
  });

  it("words each row: new, learned or improved", () => {
    const { view } = buildPanelsView(input(), ctx());
    expect(view.learning.items.map((r) => [r.skill, r.kind])).toEqual([
      ["win-quoting", "new"],
      ["svelte5", "improved"],
      ["old-new", "learned"],
      ["older", "improved"],
    ]);
    expect(view.learning.items[0]).toMatchObject({
      description: "Quote Windows paths.",
      changes: 2,
      session: { title: "Fix the login redirect" },
    });
    // A session of another folder (unknown title) is not linked.
    expect(view.learning.items[1]?.session).toBeUndefined();
  });

  it("links the latest change Hermes kept a copy of, with its line counts once known", () => {
    const { view, targets } = buildPanelsView(
      input(),
      ctx({ lineCounts: (id) => (id === "a2" ? { added: 14, removed: 3 } : undefined) }),
    );
    const row = view.learning.items[0];
    expect(row?.diff).toEqual({ key: "change:a2", added: 14, removed: 3 });
    expect(targets.get("change:a2")).toEqual({
      kind: "change",
      skill: "win-quoting",
      eventId: "a2",
    });
    // No copy kept: no diff link.
    expect(view.learning.items[3]?.diff).toBeUndefined();
    expect(targets.get(row?.history ?? "")).toEqual({ kind: "history", skill: "win-quoting" });
    expect(targets.get(row?.open ?? "")).toEqual({
      kind: "file",
      path: "C:/h/skills/dev/win-quoting/SKILL.md",
    });
  });

  it("offers All changes only when there are any", () => {
    expect(buildPanelsView(input(), ctx()).view.learning.allChanges).toBe("allChanges");
    expect(
      buildPanelsView(input({ totalChanges: 0 }), ctx()).view.learning.allChanges,
    ).toBeUndefined();
  });

  it("latestChange skips changes without a saved copy", () => {
    const l = skill("s", [ev("e1", 3, "create", "a".repeat(64)), ev("e2", 1, "archive")]);
    expect(latestChange(l)?.id).toBe("e1");
    expect(latestChange(skill("s", [ev("e3", 1, "patch")]))).toBeUndefined();
  });
});

describe("buildPanelsView — Curator", () => {
  it("says how often, the last and next run, and links the report", () => {
    const { view, targets } = buildPanelsView(input(), ctx());
    expect(view.curator).toMatchObject({
      state: "on",
      every: "weekly",
      lastRunAt: ago(4),
      summary: "1 marked stale",
      nextRunAt: ago(-3),
      minIdleHours: 2,
      consolidate: false,
    });
    expect(targets.get(view.curator.report ?? "")).toEqual({
      kind: "file",
      path: "C:\\h\\logs\\curator\\20260923/REPORT.md",
    });
  });

  it("has no next run when off or paused, and words other intervals", () => {
    const base = input().curator;
    const cur = (o: Partial<typeof base>) =>
      buildPanelsView(input({ curator: { ...base, ...o } }), ctx()).view.curator;
    expect(cur({ enabled: false })).toMatchObject({ state: "off" });
    expect(cur({ enabled: false }).nextRunAt).toBeUndefined();
    expect(cur({ paused: true }).state).toBe("paused");
    expect(cur({ paused: true }).nextRunAt).toBeUndefined();
    expect(cur({ intervalHours: 24 }).every).toBe("daily");
    expect(cur({ intervalHours: 72 }).every).toBe("every 3 days");
    expect(cur({ intervalHours: 12 }).every).toBe("every 12 h");
  });
});

describe("buildPanelsView — Memory", () => {
  it("opens each entry at its line, and the file itself", () => {
    const { view, targets } = buildPanelsView(input(), ctx());
    const notes = view.memory.notes;
    expect(notes).toMatchObject({ chars: 1800, limit: 2200 });
    expect(notes.entries.map((e) => targets.get(e.key))).toEqual([
      { kind: "file", path: "C:/h/memories/MEMORY.md", line: 1 },
      { kind: "file", path: "C:/h/memories/MEMORY.md", line: 3 },
    ]);
    expect(targets.get(notes.open)).toEqual({ kind: "file", path: "C:/h/memories/MEMORY.md" });
  });

  it("shows a proposal by its first operation", () => {
    const { view, targets } = buildPanelsView(input(), ctx());
    expect(view.memory.pending).toEqual([
      {
        id: "p1",
        action: "add",
        target: "memory",
        text: "Hermes Studio moved to the laptop.",
        more: 0,
        createdAt: ago(0.1),
        stale: false,
        key: "pending:p1",
      },
      {
        id: "p2",
        action: "replace",
        target: "user",
        text: "Prefers short replies.",
        more: 1,
        stale: true,
        key: "pending:p2",
      },
    ]);
    expect(targets.get("pending:p2")).toEqual({ kind: "pending", id: "p2" });
  });

  it("offers rewrites of the same entry as one choice, with what it says now", () => {
    const entry = "Sam wants one design language in UI: no pills.";
    const rewrite = (id: string, content: string, days: number) => ({
      id,
      action: "replace",
      summary: "- replace",
      target: "user" as const,
      createdAt: ago(days),
      ops: [{ action: "replace", oldText: "Sam wants one", content, matchedEntry: entry }],
      stale: false,
    });
    const base = input();
    const { view } = buildPanelsView(
      input({
        memory: {
          ...base.memory,
          profile: [...base.memory.profile, { text: entry, line: 2 }],
          pending: [
            rewrite("c2", "Version two.", 0.5),
            base.memory.pending[0] as (typeof base.memory.pending)[number],
            rewrite("c1", "Version one.", 1),
            // Same entry text, other file: not the same entry.
            { ...rewrite("c3", "Notes version.", 2), target: "memory" as const },
          ],
        },
      }),
      ctx(),
    );
    const rows = view.memory.pending;
    expect(rows.find((r) => r.id === "c2")).toMatchObject({
      replaces: entry,
      group: "pin:c1",
      stale: false,
    });
    // Notes has no such entry: Hermes would refuse it ("Entry changed since it was staged").
    expect(rows.find((r) => r.id === "c3")).toMatchObject({ stale: true, changed: true });
    expect(rows.find((r) => r.id === "c1")?.group).toBe("pin:c1");
    expect(rows.find((r) => r.id === "c3")?.group).toBeUndefined();
    expect(rows.find((r) => r.id === "p1")?.replaces).toBeUndefined();
    const items = pendingItems(rows);
    expect(items.map((it) => (it.kind === "one" ? it.row.id : it.rows.map((r) => r.id)))).toEqual([
      ["c2", "c1"],
      "p1",
      "c3",
    ]);
  });

  it("words what the tab says after an answer", () => {
    const row = (action: PendingRow["action"], target: PendingRow["target"]) =>
      ({ action, target }) as PendingRow;
    expect(reviewedText(row("add", "memory"), 0)).toBe("Added to Notes.");
    expect(reviewedText(row("replace", "user"), 2)).toBe("Changed in About you.");
    expect(reviewedText(row("remove", "memory"), 0)).toBe("Removed from Notes.");
    expect(reviewedText(undefined, 1)).toBe("Rejected.");
    expect(reviewedText(undefined, 3)).toBe("Rejected 3 changes.");
  });
});

describe("buildPanelsView — Capabilities and Agents", () => {
  it("lists skills with where they came from, MCP names and plugins", () => {
    const { view, targets } = buildPanelsView(input(), ctx());
    expect(view.capabilities.skills.map((x) => [x.name, x.source])).toEqual([
      ["win-quoting", "learned"],
      ["old-new", "learned"],
      ["pdf", "builtin"],
    ]);
    expect(targets.get(view.capabilities.skills[2]?.key ?? "")).toEqual({
      kind: "file",
      path: "C:/h/skills/pdf/SKILL.md",
    });
    expect(view.capabilities.mcp).toEqual([
      { name: "playwright", transport: "stdio · npx", enabled: true },
    ]);
    expect(view.capabilities.plugins).toEqual([
      { name: "mine", enabled: true },
      { name: "old", enabled: false },
      { name: "kanban", enabled: false },
    ]);
  });

  it("splits running from the last 7 days, and marks failures", () => {
    const { view, targets } = buildPanelsView(input(), ctx());
    expect(view.agents.running.map((r) => r.id)).toEqual(["deleg_run"]);
    expect(view.agents.recent.map((r) => [r.id, r.failed])).toEqual([
      ["deleg_done", false],
      ["deleg_failed", true],
    ]);
    const tasks = view.agents.running[0]?.tasks ?? [];
    expect(tasks.map((t) => t.goal)).toEqual(["Read the Codex usage response", "Task 2"]);
    expect(targets.get(tasks[0]?.key ?? "")).toEqual({ kind: "file", path: "C:/h/cache/t1.log" });
    // No log: nothing to open.
    expect(tasks[1]?.key).toBeUndefined();
  });
});

describe("panel keys", () => {
  it("are derived from the target, so an old key never opens something else", () => {
    expect(panelKey({ kind: "file", path: "C:/a.md", line: 3 })).toBe("file:3:C:/a.md");
    expect(panelKey({ kind: "file", path: "C:/a.md" })).toBe("file:0:C:/a.md");
    expect(panelKey({ kind: "session", id: "s1" })).toBe("session:s1");
  });

  it("every key in the view resolves to a target", () => {
    const { view, targets } = buildPanelsView(input(), ctx());
    const keys: string[] = [];
    JSON.stringify(view, (k, v) => {
      if (
        (k === "key" || k === "open" || k === "history" || k === "report" || k === "allChanges") &&
        typeof v === "string"
      ) {
        keys.push(v);
      }
      return v;
    });
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(targets.has(k), k).toBe(true);
  });

  it("an empty, not-found home still builds", () => {
    const { view } = buildPanelsView(
      input({
        found: false,
        learning: [],
        totalChanges: 0,
        skills: [],
        mcp: [],
        delegations: [],
        plugins: { enabled: [], disabled: [], user: [] },
      }),
      ctx(),
    );
    expect(view.found).toBe(false);
    expect(view.learning).toMatchObject({ newThisWeek: 0, unseen: 0, items: [] });
  });
});

describe("panel messages from the webview", () => {
  it("accepts a key, and the tab messages", () => {
    expect(isWebviewToHost({ type: "panelOpen", key: "file:0:C:/h/skills/pdf/SKILL.md" })).toBe(
      true,
    );
    expect(isWebviewToHost({ type: "panelSeen" })).toBe(true);
    expect(isWebviewToHost({ type: "refreshPanels" })).toBe(true);
  });

  it("refuses a missing, empty or huge key", () => {
    expect(isWebviewToHost({ type: "panelOpen" })).toBe(false);
    expect(isWebviewToHost({ type: "panelOpen", key: "" })).toBe(false);
    expect(isWebviewToHost({ type: "panelOpen", key: 3 })).toBe(false);
    expect(isWebviewToHost({ type: "panelOpen", key: "x".repeat(5000) })).toBe(false);
  });
});

describe("the tabs' words (webview)", () => {
  const week = (newThisWeek: number, improvedThisWeek: number) =>
    weekHeadline({ newThisWeek, improvedThisWeek } as LearningView);

  it("says what Hermes did this week", () => {
    expect(week(2, 4)).toBe("This week Hermes learned 2 skills and improved 4");
    expect(week(1, 0)).toBe("This week Hermes learned 1 skill");
    expect(week(0, 1)).toBe("This week Hermes improved 1 skill");
    expect(week(0, 0)).toBe("Nothing new this week");
  });

  it("names a memory proposal by its verb and file", () => {
    const p = (o: Partial<PendingRow>) =>
      pendingHeading({ action: "add", target: "memory", more: 0, ...o } as PendingRow);
    expect(p({})).toBe("Add to Notes");
    expect(p({ action: "replace", target: "user" })).toBe("Rewrite in About you");
    expect(p({ action: "remove", more: 2 })).toBe("Remove from Notes (+2 more)");
    expect(p({ action: "other" })).toBe("Change Notes");
  });

  it("filters skills by source and by name, category or description", () => {
    const skills = [
      { name: "win-quoting", category: "dev", source: "learned", key: "a" },
      { name: "pdf", description: "Read PDF files", source: "builtin", key: "b" },
      { name: "hub-thing", category: "web", source: "hub", key: "c" },
    ] as SkillRow[];
    const names = (s: Parameters<typeof filterSkills>[1], q: string) =>
      filterSkills(skills, s, q).map((x) => x.name);
    expect(names("all", "")).toEqual(["win-quoting", "pdf", "hub-thing"]);
    expect(names("learned", "")).toEqual(["win-quoting"]);
    expect(names("all", " PDF ")).toEqual(["pdf"]);
    expect(names("all", "web")).toEqual(["hub-thing"]);
    expect(names("learned", "pdf")).toEqual([]);
  });

  it("words tasks and counts", () => {
    expect(taskState("completed", false)).toBe("done");
    expect(taskState(undefined, true)).toBe("waiting");
    expect(taskState(undefined, false)).toBe("unknown");
    expect(
      runTasks({
        id: "d",
        goal: "g",
        failed: true,
        tasks: [
          { goal: "a", status: "completed" },
          { goal: "b", status: "failed" },
        ],
      }),
    ).toBe("2 tasks, 1 failed");
    expect(kChars(1834)).toBe("1.8k");
    expect(kChars(900)).toBe("900");
    expect(isTab("memory")).toBe(true);
    expect(isTab("settings")).toBe(false);
  });
});
