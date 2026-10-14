import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  curatorSummaryShort,
  curatorView,
  mcpServers,
  parseConfig,
  parseDelegation,
  parseLedger,
  parsePending,
  parseUsage,
  previewPending,
  recentLearning,
  skillFrontmatter,
  skillSource,
  splitMemory,
} from "../src/logic/hermesData";
import {
  agentsTree,
  capabilitiesTree,
  curatorTree,
  learningTree,
  memoryTree,
  pendingLabel,
  unseenLearning,
} from "../src/logic/panelTrees";
import { hermesHome, readBlob, readSnapshot } from "../src/host/hermesHome";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const line = (o: object) => JSON.stringify(o);

// Rows shaped as Hermes 0.21.5 writes them (tools/skill_ledger.py).
const LEDGER = [
  line({
    id: "a1",
    ts: iso(2),
    actor: "curator",
    action: "create",
    skill: "win-quoting",
    evidence: { session_id: "sess-1" },
    before: [],
    after: [{ path: "C:\\h\\skills\\dev\\win-quoting\\SKILL.md", sha256: "b".repeat(64) }],
  }),
  line({
    id: "a2",
    ts: iso(1),
    actor: "curator",
    action: "patch",
    skill: "win-quoting",
    evidence: { session_id: "sess-2" },
    before: [{ path: "C:\\h\\skills\\dev\\win-quoting\\SKILL.md", sha256: "b".repeat(64) }],
    after: [{ path: "C:\\h\\skills\\dev\\win-quoting\\SKILL.md", sha256: "c".repeat(64) }],
  }),
  line({
    id: "a3",
    ts: iso(10),
    actor: "agent",
    action: "patch",
    skill: "svelte5",
    evidence: {},
    before: [],
    after: [],
  }),
  line({
    id: "a4",
    ts: iso(3),
    actor: "user",
    action: "archive",
    skill: "old-thing",
    evidence: {},
  }),
  line({
    id: "a5",
    ts: iso(40),
    actor: "curator",
    action: "patch",
    skill: "ancient",
    evidence: {},
  }),
  line({ id: "a2", ts: iso(1), actor: "curator", action: "patch", skill: "win-quoting" }), // duplicate id
  "not json",
  "",
].join("\r\n");

describe("hermesData parsers", () => {
  it("reads the ledger: dedupes ids, skips junk, keeps the SKILL.md path and hashes", () => {
    const events = parseLedger(LEDGER);
    expect(events.map((e) => e.id)).toEqual(["a5", "a3", "a4", "a1", "a2"]); // oldest first
    const patch = events.find((e) => e.id === "a2");
    expect(patch).toMatchObject({
      sessionId: "sess-2",
      path: "C:\\h\\skills\\dev\\win-quoting\\SKILL.md",
      beforeSha: "b".repeat(64),
      afterSha: "c".repeat(64),
    });
    expect(events.find((e) => e.id === "a1")?.beforeSha).toBeUndefined();
  });

  it("summarises the last 30 days per skill, newest first, without the user's own changes", () => {
    const learned = recentLearning(parseLedger(LEDGER), NOW);
    expect(learned.map((l) => [l.skill, l.isNew, l.changes])).toEqual([
      ["win-quoting", true, 2],
      ["svelte5", false, 1],
    ]);
    expect(learned[0]?.lastSessionId).toBe("sess-2");
  });

  it("splits memory on a line holding only §, CRLF or LF, and records where entries start", () => {
    expect(splitMemory("First fact\r\nmore\r\n§\r\nSecond\r\n§\r\n\r\n")).toEqual([
      { text: "First fact\nmore", line: 0 },
      { text: "Second", line: 3 },
    ]);
    expect(splitMemory("a § b")).toEqual([{ text: "a § b", line: 0 }]);
    expect(splitMemory(undefined)).toEqual([]);
  });

  it("reads a pending proposal (epoch seconds) and a delegation (local wall clock)", () => {
    expect(
      parsePending(
        line({
          id: "p1",
          action: "batch",
          summary: "replace  entry\n x",
          origin: "background_review",
          created_at: 1790104682.5,
        }),
      ),
    ).toMatchObject({
      id: "p1",
      action: "batch",
      summary: "replace entry x",
      origin: "background_review",
      createdAt: 1790104682500,
    });
    const d = parseDelegation(
      line({
        delegation_id: "deleg_1",
        started: "2026-09-19 18:23:05",
        completed: "2026-09-19 18:32:06",
        tasks: [{ index: 0, goal: "Audit it", log: "x.log", status: "completed" }],
      }),
    );
    expect(d?.completedAt && d.startedAt && d.completedAt - d.startedAt).toBe(541_000);
    expect(d?.tasks).toEqual([{ goal: "Audit it", log: "x.log", status: "completed" }]);
    expect(parseDelegation("{broken")).toBeUndefined();
  });

  it("computes the curator's next run from Hermes's defaults", () => {
    const v = curatorView(
      line({
        last_run_at: "2026-09-23T09:26:32+00:00",
        last_run_summary: "auto: 1 marked stale; llm: skipped",
        run_count: 4,
      }),
      {},
    );
    expect(v).toMatchObject({
      enabled: true,
      paused: false,
      consolidate: false,
      intervalHours: 168,
      runCount: 4,
    });
    expect(new Date(v.nextRunAt ?? 0).toISOString()).toBe("2026-09-30T09:26:32.000Z");
    expect(curatorSummaryShort(v.summary)).toBe("1 marked stale");
    expect(curatorView(undefined, { curator: { enabled: false } }).enabled).toBe(false);
  });

  it("reads a skill's frontmatter, and tells where a skill came from like Hermes does", () => {
    expect(skillFrontmatter("---\nname: x\ndescription: >\n  Does\n  things\n---\n# X")).toEqual({
      name: "x",
      description: "Does things",
    });
    expect(skillFrontmatter("no frontmatter")).toEqual({});
    const usage = parseUsage(
      line({ a: { created_by: "agent" }, b: { created_by: "installed" }, c: {} }),
    );
    const hub = new Set(["h"]);
    const bundled = new Set(["x", "a"]);
    expect(skillSource("h", hub, bundled, usage)).toBe("hub");
    expect(skillSource("a", hub, bundled, usage)).toBe("builtin"); // bundled wins over the usage marker
    expect(skillSource("b", hub, new Set(), usage)).toBe("hub");
    expect(skillSource("a", new Set(), new Set(), usage)).toBe("learned");
    expect(skillSource("c", hub, bundled, usage)).toBe("local");
  });

  it("names MCP servers without ever copying their env, headers or args", () => {
    const config = parseConfig(
      "mcp_servers:\n  playwright:\n    command: C:\\\\bin\\\\npx.cmd\n    args: [--token, SECRET1]\n    env:\n      API_KEY: SECRET2\n  remote:\n    url: https://x\n    headers:\n      Authorization: SECRET3\n    enabled: false\n",
    );
    const servers = mcpServers(config);
    expect(servers).toEqual([
      { name: "playwright", transport: "stdio · npx", enabled: true },
      { name: "remote", transport: "http", enabled: false },
    ]);
    expect(JSON.stringify(servers)).not.toMatch(/SECRET/);
    expect(parseConfig("key: [unclosed")).toEqual({});
  });
});

describe("memory proposals", () => {
  const record = (ops: object[], target = "memory") =>
    line({
      id: "p9",
      action: "batch",
      summary: "background review consolidation (batch on memory): - replace: Uses PowerShell",
      origin: "background_review",
      created_at: 1790104682,
      payload: { action: "batch", target, operations: ops },
    });

  it("an unpinned replace/remove is outdated: Hermes refuses to approve it", () => {
    const old = parsePending(
      record([{ action: "replace", old_text: "PowerShell", content: "new" }]),
    );
    expect(old).toMatchObject({
      target: "memory",
      stale: true,
      ops: [{ action: "replace", oldText: "PowerShell", content: "new" }],
    });
    const pinned = parsePending(
      record(
        [
          {
            action: "replace",
            old_text: "PowerShell",
            content: "new",
            matched_entry: "Uses PowerShell 7",
          },
        ],
        "user",
      ),
    );
    expect(pinned).toMatchObject({ target: "user", stale: false });
    // An add alone is never outdated (it needs no entry to match).
    expect(parsePending(record([{ action: "add", content: "x" }]))?.stale).toBe(false);
  });

  it("previews the change the way Hermes applies it", () => {
    const entries = ["Uses PowerShell 7", "Ships Synthra to npm", "test"];
    const { entries: after, problems } = previewPending(entries, [
      // replace swaps the WHOLE entry that contains old_text
      { action: "replace", oldText: "PowerShell", content: "Uses PowerShell 7.5 and Windows 11" },
      // an exact whole-entry match wins over substring matches ("test" is inside nothing else here)
      { action: "remove", oldText: "test" },
      { action: "add", content: "Likes mocks first" },
      { action: "add", content: "Likes mocks first" }, // duplicate add: skipped
      { action: "remove", oldText: "no such text" },
    ]);
    expect(after).toEqual([
      "Uses PowerShell 7.5 and Windows 11",
      "Ships Synthra to npm",
      "Likes mocks first",
    ]);
    expect(problems).toEqual(["remove: no entry matches “no such text” any more"]);
  });

  it("refuses an ambiguous match, and a pinned op hits exactly its entry", () => {
    const entries = ["Sam reviews diffs", "Sam reviews mocks"];
    expect(
      previewPending(entries, [{ action: "remove", oldText: "Sam reviews" }]).problems,
    ).toEqual(["remove: more than one entry matches “Sam reviews”"]);
    expect(
      previewPending(entries, [
        { action: "remove", oldText: "Sam reviews", matchedEntry: "Sam reviews mocks" },
      ]).entries,
    ).toEqual(["Sam reviews diffs"]);
  });

  it("labels a proposal by what it does, not by Hermes's summary line", () => {
    const one = parsePending(
      record([{ action: "replace", old_text: "Windows quirk: a", content: "x" }]),
    );
    const many = parsePending(
      record([
        { action: "remove", old_text: "Sam ships their own" },
        { action: "add", content: "y" },
        { action: "replace", old_text: "z", content: "w" },
      ]),
    );
    expect(one && pendingLabel(one)).toBe("Rewrite “Windows quirk: a”");
    expect(many && pendingLabel(many)).toBe("Remove “Sam ships their own” (+2 more)");
  });

  it("the tree marks outdated proposals and offers the terminal on the parent row", () => {
    const pending = [
      parsePending(record([{ action: "replace", old_text: "a", content: "b" }])),
    ].filter((p): p is NonNullable<typeof p> => p !== undefined);
    const nodes = memoryTree({
      notes: [],
      profile: [],
      notesChars: 0,
      profileChars: 0,
      limits: { notes: 2200, profile: 1375 },
      pending,
      notesPath: "M.md",
      profilePath: "U.md",
      now: NOW,
    });
    const parent = nodes.find((n) => n.id === "mem:pending");
    expect(parent).toMatchObject({
      description: "1 · all outdated",
      contextValue: "hermesPendingMemory",
    });
    expect(parent?.tooltip).toContain("Hermes will refuse to approve it");
    expect(parent?.children?.[0]).toMatchObject({
      label: "Rewrite “a”",
      icon: { id: "warning" },
      open: { kind: "pending", id: "p9" },
    });
    expect(parent?.children?.[0]?.description).toMatch(/^can't be approved · Notes · /);
  });
});

describe("panel trees", () => {
  const learning = recentLearning(parseLedger(LEDGER), NOW);

  it("Learning: new skills get a coloured sparkle, and the last row lists every change", () => {
    const nodes = learningTree({
      learning,
      totalChanges: 5,
      firstChangeAt: NOW - 40 * 86_400_000,
      now: NOW,
      sessionTitle: (id) => (id === "sess-2" ? "Fix the login redirect" : undefined),
    });
    expect(nodes.map((n) => n.label)).toEqual(["win-quoting", "svelte5", "All 5 changes"]);
    expect(nodes[0]?.icon).toEqual({ id: "sparkle", color: "charts.yellow" });
    expect(nodes[0]?.description).toMatch(/^new · 2 changes · /);
    expect(nodes[0]?.tooltip).toContain("while working on “Fix the login redirect”");
    expect(nodes[0]?.children?.map((c) => c.label)).toEqual(["Improved", "Created"]); // newest first
    expect(nodes[0]?.children?.[0]?.open).toEqual({
      kind: "change",
      skill: "win-quoting",
      eventId: "a2",
    });
    expect(nodes[1]?.icon).toEqual({ id: "edit" });
    expect(nodes[2]?.open).toEqual({ kind: "allChanges" });
  });

  it("the badge counts skills changed since the user last looked", () => {
    expect(unseenLearning(learning, 0)).toBe(2);
    expect(unseenLearning(learning, NOW - 1.5 * 86_400_000)).toBe(1);
    expect(unseenLearning(learning, NOW)).toBe(0);
  });

  it("Curator: state, last run with its report, next run, merging", () => {
    const c = curatorView(
      line({
        last_run_at: iso(4),
        last_run_summary: "auto: 1 marked stale",
        last_report_path: "C:\\h\\logs\\curator\\1",
      }),
      {},
    );
    const nodes = curatorTree(c, NOW);
    expect(nodes.map((n) => n.label)).toEqual([
      "On · every 7 days",
      expect.stringMatching(/^Last run /),
      expect.stringMatching(/^Next run from /),
      "Merging similar skills",
    ]);
    expect(nodes[1]?.open).toEqual({ kind: "file", path: "C:\\h\\logs\\curator\\1/REPORT.md" });
    expect(nodes[1]?.description).toBe("1 marked stale");
    expect(curatorTree({ ...c, paused: true }, NOW)[0]?.label).toBe("Paused");
    expect(curatorTree(curatorView(undefined, {}), NOW).map((n) => n.label)).toContain(
      "Not run yet",
    );
  });

  it("Memory: entries open at their line; pending proposals only when there are some", () => {
    const nodes = memoryTree({
      notes: [{ text: "Uses PowerShell 7\nmore", line: 0 }],
      profile: [],
      notesChars: 22,
      profileChars: 0,
      limits: { notes: 2200, profile: 1375 },
      pending: [],
      notesPath: "M.md",
      profilePath: "U.md",
      now: NOW,
    });
    expect(nodes.map((n) => n.label)).toEqual(["Notes", "About you"]);
    expect(nodes[0]?.description).toBe("1 entry · 22 / 2.2k chars");
    expect(nodes[0]?.children?.[0]).toMatchObject({
      label: "Uses PowerShell 7",
      open: { kind: "file", path: "M.md", line: 1 },
    });
  });

  it("Capabilities: skill groups by source (empty ones hidden), connectors, plugins", () => {
    const nodes = capabilitiesTree(
      [
        { name: "a", path: "a/SKILL.md", source: "learned" },
        { name: "b", path: "b/SKILL.md", source: "builtin", category: "dev" },
      ],
      [{ name: "playwright", transport: "stdio · npx", enabled: true }],
      { enabled: [], disabled: [], user: [] },
    );
    expect(nodes.map((n) => [n.label, n.description])).toEqual([
      ["Skills", "2"],
      ["Connectors (MCP)", "1"],
      ["Plugins", "none added"],
    ]);
    expect(nodes[0]?.children?.map((g) => g.label)).toEqual(["Learned by Hermes", "Built in"]);
  });

  it("Agents: running ones first, recent ones from the last 7 days, failures marked", () => {
    const nodes = agentsTree(
      [
        { id: "d1", startedAt: NOW - 60_000, tasks: [{ goal: "Running job", status: "running" }] },
        {
          id: "d2",
          startedAt: NOW - 86_400_000,
          completedAt: NOW - 86_400_000 + 300_000,
          tasks: [{ goal: "Audit", status: "failed", log: "t.log" }],
        },
        { id: "d3", startedAt: NOW - 9 * 86_400_000, completedAt: NOW - 9 * 86_400_000, tasks: [] },
      ],
      NOW,
    );
    expect(nodes[0]).toMatchObject({ label: "Running now", description: "1", expanded: true });
    expect(nodes[1]?.description).toBe("1 · last 7 days");
    expect(nodes[1]?.children?.[0]).toMatchObject({ label: "Audit", icon: { id: "error" } });
    expect(nodes[1]?.children?.[0]?.description).toMatch(/^1 task · 5 min · /);
    expect(nodes[1]?.children?.[0]?.children?.[0]?.open).toEqual({ kind: "file", path: "t.log" });
  });
});

describe("readSnapshot (a fake HERMES_HOME)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fakeHome(): string {
    const h = mkdtempSync(join(tmpdir(), "hs-home-"));
    dirs.push(h);
    const w = (p: string, text: string) => {
      mkdirSync(join(h, p, ".."), { recursive: true });
      writeFileSync(join(h, p), text);
    };
    w("skills/.curator_ledger.jsonl", LEDGER);
    w("skills/.usage.json", line({ "win-quoting": { created_by: "agent" } }));
    w("skills/.bundled_manifest", "svelte5:abc\r\n");
    w("skills/.curator_state", line({ last_run_at: iso(4), run_count: 1 }));
    w("skills/dev/win-quoting/SKILL.md", "---\nname: win-quoting\ndescription: Quote paths\n---\n");
    w("skills/svelte5/SKILL.md", "---\nname: svelte5\n---\n");
    w("memories/MEMORY.md", "one\r\n§\r\ntwo");
    w("memories/USER.md", "Sam");
    w(
      "pending/memory/p1.json",
      line({ id: "p1", action: "add", summary: "s", created_at: 1790104682 }),
    );
    w(
      "cache/delegation/live/deleg_1/manifest.json",
      line({ delegation_id: "deleg_1", started: "2026-09-26 10:00:00", tasks: [] }),
    );
    w(
      "config.yaml",
      "memory:\n  memory_char_limit: 3500\nmcp_servers:\n  playwright:\n    command: npx\n    env:\n      TOKEN: SECRET_ENV\n",
    );
    // Credentials Hermes keeps next to its state: never read.
    w("auth.json", '{"token":"SECRET_AUTH"}');
    w(".env", "OPENAI_API_KEY=SECRET_DOTENV");
    return h;
  }

  it("reads every panel's data, and nothing secret ends up in it", async () => {
    const s = await readSnapshot(fakeHome(), NOW);
    expect(s.found).toBe(true);
    expect(s.learning.map((l) => l.skill)).toEqual(["win-quoting", "svelte5"]);
    // The link goes to the skill's CURRENT file, not the ledger's old path.
    expect(s.learning[0]?.path).toMatch(/dev[\\/]win-quoting[\\/]SKILL\.md$/);
    expect(s.skills.map((k) => [k.name, k.source, k.category])).toEqual([
      ["svelte5", "builtin", undefined],
      ["win-quoting", "learned", "dev"],
    ]);
    expect(s.memory.notes.map((e) => e.text)).toEqual(["one", "two"]);
    expect(s.memory.limits.notes).toBe(3500);
    expect(s.memory.pending).toHaveLength(1);
    expect(s.delegations.map((d) => d.id)).toEqual(["deleg_1"]);
    expect(s.mcp).toEqual([{ name: "playwright", transport: "stdio · npx", enabled: true }]);
    expect(JSON.stringify(s)).not.toMatch(/SECRET/);
  });

  // Skills added as junctions into ~/.agents/skills: Hermes (and
  // its "/" menu) follows them, so the Capabilities tab and our "/" list must too.
  it("follows a skill folder that is a link (a junction on Windows)", async () => {
    const h = fakeHome();
    const elsewhere = mkdtempSync(join(tmpdir(), "hs-agents-"));
    dirs.push(elsewhere);
    mkdirSync(join(elsewhere, "hubspot-cms-cli"));
    writeFileSync(
      join(elsewhere, "hubspot-cms-cli", "SKILL.md"),
      "---\nname: hubspot-cms-cli\ndescription: Run the HubSpot CLI\n---\n",
    );
    symlinkSync(
      join(elsewhere, "hubspot-cms-cli"),
      join(h, "skills/dev/hubspot-cms-cli"),
      "junction",
    );
    // A link to nothing is left out.
    symlinkSync(join(elsewhere, "gone"), join(h, "skills/dev/gone"), "junction");
    const s = await readSnapshot(h, NOW);
    const hub = s.skills.find((k) => k.name === "hubspot-cms-cli");
    expect(hub).toMatchObject({ category: "dev", description: "Run the HubSpot CLI" });
    expect(s.skills.map((k) => k.name)).not.toContain("gone");
  });

  it("an absent folder is reported as not found, with empty panels", async () => {
    const s = await readSnapshot(join(tmpdir(), "hs-no-such-hermes-home-xyz"), NOW);
    expect(s.found).toBe(false);
    expect(s.learning).toEqual([]);
    expect(s.skills).toEqual([]);
  });

  it("reads a backup blob by its hash, and refuses anything that is not a hash", async () => {
    const h = fakeHome();
    mkdirSync(join(h, ".curator_backups", "blobs"), { recursive: true });
    writeFileSync(join(h, ".curator_backups", "blobs", "c".repeat(64)), "after text");
    expect(await readBlob(h, "c".repeat(64))).toBe("after text");
    expect(await readBlob(h, "../../auth.json")).toBeUndefined();
  });

  it("finds Hermes's home like Hermes does", () => {
    expect(hermesHome({ HERMES_HOME: "D:\\h" }, "win32", "C:\\Users\\J")).toBe("D:\\h");
    expect(
      hermesHome({ LOCALAPPDATA: "C:\\Users\\J\\AppData\\Local" }, "win32", "C:\\Users\\J"),
    ).toBe("C:\\Users\\J\\AppData\\Local\\hermes");
    expect(hermesHome({}, "linux", "/home/j")).toBe("/home/j/.hermes");
  });
});
