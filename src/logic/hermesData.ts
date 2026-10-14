// Hermes's own files, parsed for the side panels (slice 5). Pure: text in,
// data out; the host does the reading. Every parser is tolerant — a missing,
// half-written or unexpected file yields an empty result, never a throw: the
// files belong to Hermes, which may change them (or their format) any time.
//
// Sources, verified on Hermes 0.21.5 (HERMES_HOME = %LOCALAPPDATA%\hermes):
//   skills/.curator_ledger.jsonl  one JSON object per skill change
//     {id, ts (UTC ISO), actor: curator|agent|user, action, skill,
//      evidence{session_id}, before[{path, sha256}], after[{path, sha256}]}
//     NB: writes by the post-turn background review (Hermes's self-learning)
//     are tagged actor "curator", not "agent" (tools/skill_ledger.py:68-77).
//   skills/.usage.json            {name: {created_by: agent|learn|installed|null,
//     created_at, state, pinned, use_count, patch_count, last_used_at, …}}
//   skills/.bundled_manifest      "name:hash" lines (CRLF on Windows)
//   skills/.hub/lock.json         {installed: {name: {…}}}
//   skills/.curator_state         {last_run_at, last_run_summary, paused,
//     run_count, last_report_path, …}
//   memories/MEMORY.md, USER.md   entries separated by a line holding only "§"
//   pending/memory/<id>.json      {id, action, summary, origin, created_at (epoch s)}
//   cache/delegation/live/deleg_*/manifest.json
//     {delegation_id, started, completed? ("YYYY-MM-DD HH:MM:SS", local),
//      task_count, model, tasks[{index, goal, log, status, exit_reason}]}
//   config.yaml                   curator.*, memory.*_char_limit, mcp_servers,
//     plugins — only non-secret keys are read (never env/headers).

import { parse as parseYaml } from "yaml";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function jsonObj(text: string | undefined): Obj | undefined {
  if (!text) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** ISO 8601 → epoch ms; undefined for anything else. */
function isoMs(v: unknown): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** "2026-09-19 18:23:05" (Hermes's local wall clock, no zone) → epoch ms. */
function localMs(v: unknown): number | undefined {
  const s = str(v);
  const m = s && /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return isoMs(v);
  const [, y, mo, d, h, mi, se] = m.map(Number) as number[];
  return new Date(y as number, (mo as number) - 1, d, h, mi, se).getTime();
}

// ─── learning: the skill ledger ─────────────────────────────────────────────

export interface LedgerEvent {
  id: string;
  /** Epoch ms. */
  ts: number;
  actor: string;
  action: string;
  skill: string;
  sessionId?: string;
  /** The skill's SKILL.md (or the changed file) after the change. */
  path?: string;
  /** Content hashes of that file before/after, for a diff from the backups. */
  beforeSha?: string;
  afterSha?: string;
}

export function parseLedger(text: string): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const o = jsonObj(line);
    const id = str(o?.id);
    const ts = isoMs(o?.ts);
    const skill = str(o?.skill);
    const action = str(o?.action);
    if (!o || !id || ts === undefined || !skill || !action || seen.has(id)) continue;
    seen.add(id);
    const after = Array.isArray(o.after) ? o.after.filter(isObj) : [];
    const before = Array.isArray(o.before) ? o.before.filter(isObj) : [];
    // Prefer the SKILL.md entry: that is the file to open.
    const pick = (list: Obj[]) =>
      list.find((f) => /SKILL\.md$/i.test(String(f.path ?? ""))) ?? list[0];
    const a = pick(after);
    const b = pick(before);
    const path = str(a?.path) ?? str(b?.path);
    const evidence = isObj(o.evidence) ? o.evidence : {};
    out.push({
      id,
      ts,
      actor: str(o.actor) ?? "unknown",
      action,
      skill,
      ...(str(evidence.session_id) ? { sessionId: str(evidence.session_id) } : {}),
      ...(path ? { path } : {}),
      ...(str(b?.sha256) && str(b?.path) === path ? { beforeSha: str(b?.sha256) } : {}),
      ...(str(a?.sha256) ? { afterSha: str(a?.sha256) } : {}),
    });
  }
  return out.sort((x, y) => x.ts - y.ts);
}

export interface SkillUsage {
  createdBy?: string;
  createdAt?: number;
  state?: string;
  pinned: boolean;
  useCount: number;
  lastUsedAt?: number;
}

export function parseUsage(text: string | undefined): Map<string, SkillUsage> {
  const out = new Map<string, SkillUsage>();
  const o = jsonObj(text);
  for (const [name, r] of Object.entries(o ?? {})) {
    if (!isObj(r)) continue;
    const createdAt = isoMs(r.created_at);
    const lastUsedAt = isoMs(r.last_used_at);
    out.set(name, {
      ...(str(r.created_by) ? { createdBy: str(r.created_by) } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(str(r.state) ? { state: str(r.state) } : {}),
      pinned: r.pinned === true,
      useCount: num(r.use_count) ?? 0,
      ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    });
  }
  return out;
}

/** One skill's line in the Learning panel. */
export interface LearnedSkill {
  skill: string;
  /** Created by Hermes within the window (a "new" skill), not just changed. */
  isNew: boolean;
  createdAt?: number;
  lastChangeAt: number;
  /** Changes in the window (create counts as one). */
  changes: number;
  lastSessionId?: string;
  path?: string;
  events: LedgerEvent[];
}

const DAY = 86_400_000;

/**
 * What Hermes learned lately: skills with ledger events in the last `days`,
 * newest first. User-made changes (actor "user", the `hermes curator` CLI) are
 * not learning and are left out.
 */
export function recentLearning(
  events: readonly LedgerEvent[],
  now: number,
  days = 30,
): LearnedSkill[] {
  const since = now - days * DAY;
  const bySkill = new Map<string, LedgerEvent[]>();
  for (const e of events) {
    if (e.ts < since || e.actor === "user") continue;
    const list = bySkill.get(e.skill) ?? [];
    list.push(e);
    bySkill.set(e.skill, list);
  }
  const out: LearnedSkill[] = [];
  for (const [skill, list] of bySkill) {
    const created = list.find((e) => e.action === "create");
    const last = list[list.length - 1] as LedgerEvent;
    const withPath = [...list].reverse().find((e) => e.path);
    out.push({
      skill,
      isNew: created !== undefined,
      ...(created ? { createdAt: created.ts } : {}),
      lastChangeAt: last.ts,
      changes: list.length,
      ...(last.sessionId ? { lastSessionId: last.sessionId } : {}),
      ...(withPath?.path ? { path: withPath.path } : {}),
      events: list,
    });
  }
  return out.sort((a, b) => b.lastChangeAt - a.lastChangeAt);
}

// ─── curator ────────────────────────────────────────────────────────────────

export interface CuratorView {
  enabled: boolean;
  paused: boolean;
  consolidate: boolean;
  lastRunAt?: number;
  summary?: string;
  runCount: number;
  /** When Hermes will next consider a run (it also waits for idle time). */
  nextRunAt?: number;
  intervalHours: number;
  minIdleHours: number;
  reportDir?: string;
}

/** Hermes's defaults (hermes_cli/config_defaults.py). */
const CURATOR_DEFAULTS = {
  enabled: true,
  interval_hours: 168,
  min_idle_hours: 2,
  consolidate: false,
};

export function curatorView(stateText: string | undefined, config: Obj): CuratorView {
  const s = jsonObj(stateText) ?? {};
  const c = isObj(config.curator) ? config.curator : {};
  const enabled = typeof c.enabled === "boolean" ? c.enabled : CURATOR_DEFAULTS.enabled;
  const intervalHours = num(c.interval_hours) ?? CURATOR_DEFAULTS.interval_hours;
  const minIdleHours = num(c.min_idle_hours) ?? CURATOR_DEFAULTS.min_idle_hours;
  const lastRunAt = isoMs(s.last_run_at);
  return {
    enabled,
    paused: s.paused === true,
    consolidate: typeof c.consolidate === "boolean" ? c.consolidate : CURATOR_DEFAULTS.consolidate,
    ...(lastRunAt !== undefined
      ? { lastRunAt, nextRunAt: lastRunAt + intervalHours * 3_600_000 }
      : {}),
    ...(str(s.last_run_summary) ? { summary: str(s.last_run_summary) } : {}),
    runCount: num(s.run_count) ?? 0,
    intervalHours,
    minIdleHours,
    ...(str(s.last_report_path) ? { reportDir: str(s.last_report_path) } : {}),
  };
}

/** "auto: 1 marked stale; llm: skipped (consolidation off)" → "1 marked stale". */
export function curatorSummaryShort(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  return /auto:\s*([^;]+)/.exec(summary)?.[1]?.trim() || summary;
}

// ─── memory ─────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  text: string;
  /** 0-based line where the entry starts, for "open at". */
  line: number;
}

/** Entries are separated by a line holding only "§" (tools/memory_tool_store.py). */
export function splitMemory(text: string | undefined): MemoryEntry[] {
  if (!text) return [];
  const out: MemoryEntry[] = [];
  let line = 0;
  let start = 0;
  let buf: string[] = [];
  const lines = text.split(/\r?\n/);
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) out.push({ text: t, line: start });
  };
  for (const l of lines) {
    if (l.trim() === "§") {
      flush();
      buf = [];
      start = line + 1;
    } else {
      buf.push(l);
    }
    line++;
  }
  flush();
  return out;
}

export interface MemoryLimits {
  notes: number;
  profile: number;
}

export function memoryLimits(config: Obj): MemoryLimits {
  const m = isObj(config.memory) ? config.memory : {};
  return { notes: num(m.memory_char_limit) ?? 2200, profile: num(m.user_char_limit) ?? 1375 };
}

export interface PendingOp {
  action: string;
  oldText?: string;
  content?: string;
  /** The full entry the proposal was reviewed against ("entry pinning"). */
  matchedEntry?: string;
}

export interface PendingMemory {
  id: string;
  action: string;
  summary: string;
  origin?: string;
  createdAt?: number;
  /** Which file it changes: MEMORY.md ("memory") or USER.md ("user"). */
  target: "memory" | "user";
  ops: PendingOp[];
  /**
   * A replace/remove without a pinned entry. Hermes refuses to approve such a
   * record ("predates entry pinning and cannot be verified; nothing was
   * applied. Reject it and recreate the change." — tools/memory_tool.py:294).
   */
  stale: boolean;
}

const DESTRUCTIVE = new Set(["replace", "remove"]);

export function parsePending(text: string | undefined): PendingMemory | undefined {
  const o = jsonObj(text);
  const id = str(o?.id);
  if (!o || !id) return undefined;
  const at = num(o.created_at);
  const payload = isObj(o.payload) ? o.payload : {};
  const raw =
    payload.action === "batch" && Array.isArray(payload.operations)
      ? payload.operations
      : [payload];
  const ops: PendingOp[] = raw.filter(isObj).map((op) => ({
    action: str(op.action) ?? "",
    ...(str(op.old_text) ? { oldText: str(op.old_text) } : {}),
    ...(str(op.content) ? { content: str(op.content) } : {}),
    ...(str(op.matched_entry) ? { matchedEntry: str(op.matched_entry) } : {}),
  }));
  return {
    id,
    action: str(o.action) ?? "change",
    summary: (str(o.summary) ?? "").replace(/\s+/g, " ").trim(),
    ...(str(o.origin) ? { origin: str(o.origin) } : {}),
    ...(at !== undefined ? { createdAt: at < 1e12 ? at * 1000 : at } : {}),
    target: payload.target === "user" ? "user" : "memory",
    ops,
    stale: ops.some((op) => DESTRUCTIVE.has(op.action) && !op.matchedEntry),
  };
}

/**
 * What the file would look like with the proposal applied, the way Hermes
 * applies it (tools/memory_tool_store.py): a pinned op hits exactly its entry;
 * otherwise an exact whole-entry match wins, then a unique substring match;
 * replace swaps the WHOLE entry; add skips duplicates. A preview only — the
 * panels never write memory.
 */
export function previewPending(
  entries: readonly string[],
  ops: readonly PendingOp[],
): { entries: string[]; problems: string[] } {
  const working = [...entries];
  const problems: string[] = [];
  const short = (s: string) => (s.length > 50 ? `${s.slice(0, 49)}…` : s);
  for (const op of ops) {
    if (op.action === "add") {
      if (op.content && !working.includes(op.content)) working.push(op.content);
      continue;
    }
    if (!DESTRUCTIVE.has(op.action)) {
      problems.push(`unknown action “${op.action}”`);
      continue;
    }
    let idx: number;
    if (op.matchedEntry) {
      idx = working.indexOf(op.matchedEntry);
    } else {
      const old = (op.oldText ?? "").trim();
      const exact = working.map((e, i) => (e === old ? i : -1)).filter((i) => i >= 0);
      const hits = exact.length
        ? exact
        : working.map((e, i) => (old && e.includes(old) ? i : -1)).filter((i) => i >= 0);
      if (new Set(hits.map((i) => working[i])).size > 1) {
        problems.push(`${op.action}: more than one entry matches “${short(old)}”`);
        continue;
      }
      idx = hits[0] ?? -1;
    }
    if (idx < 0) {
      problems.push(
        `${op.action}: no entry matches “${short(op.matchedEntry ?? op.oldText ?? "")}” any more`,
      );
      continue;
    }
    if (op.action === "replace") working[idx] = op.content ?? "";
    else working.splice(idx, 1);
  }
  return { entries: working, problems };
}

// ─── capabilities ───────────────────────────────────────────────────────────

export type SkillSource = "learned" | "hub" | "builtin" | "local";

export interface SkillInfo {
  name: string;
  description?: string;
  category?: string;
  path: string;
  source: SkillSource;
}

/** The YAML frontmatter's name and description ("---" … "---" at the top). */
export function skillFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  try {
    const fm: unknown = parseYaml(m[1] as string);
    if (!isObj(fm)) return {};
    const name = str(fm.name);
    const description = str(fm.description)?.replace(/\s+/g, " ").trim();
    return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
  } catch {
    return {};
  }
}

export function parseBundled(text: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const l of (text ?? "").split(/\r?\n/)) {
    const name = l.split(":")[0]?.trim();
    if (name) out.add(name);
  }
  return out;
}

export function parseHubLock(text: string | undefined): Set<string> {
  const o = jsonObj(text);
  return new Set(isObj(o?.installed) ? Object.keys(o.installed) : []);
}

/** Hermes's own precedence (tools/skill_usage.py provenance()): hub, then
 *  bundled, then the agent's; "learned" when the agent created it itself. */
export function skillSource(
  name: string,
  hub: Set<string>,
  bundled: Set<string>,
  usage: Map<string, SkillUsage>,
): SkillSource {
  if (hub.has(name)) return "hub";
  if (bundled.has(name)) return "builtin";
  const by = usage.get(name)?.createdBy;
  if (by === "agent" || by === "learn") return "learned";
  if (by === "installed") return "hub";
  return "local";
}

export interface McpServer {
  name: string;
  /** "stdio: npx" or "http" — never its args, env or headers (secrets live there). */
  transport: string;
  enabled: boolean;
}

export function mcpServers(config: Obj): McpServer[] {
  const servers = isObj(config.mcp_servers) ? config.mcp_servers : {};
  return Object.entries(servers).map(([name, s]) => {
    const o = isObj(s) ? s : {};
    const command = str(o.command);
    const exe = command
      ?.split(/[\\/]/)
      .pop()
      ?.replace(/\.(exe|cmd|bat)$/i, "");
    return {
      name,
      transport: command ? `stdio · ${exe}` : str(o.url) ? "http" : "unknown",
      enabled: o.enabled !== false,
    };
  });
}

export function parseConfig(text: string | undefined): Obj {
  if (!text) return {};
  try {
    const v: unknown = parseYaml(text);
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

/** Plugins switched on in config (bundled ones Hermes loads by default are
 *  not listed here: they are part of Hermes, not something you added). */
export function configuredPlugins(config: Obj): { enabled: string[]; disabled: string[] } {
  const p = isObj(config.plugins) ? config.plugins : {};
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return { enabled: list(p.enabled), disabled: list(p.disabled) };
}

// ─── agents ─────────────────────────────────────────────────────────────────

export interface Delegation {
  id: string;
  startedAt?: number;
  completedAt?: number;
  tasks: { goal: string; log?: string; status?: string }[];
}

export function parseDelegation(text: string | undefined): Delegation | undefined {
  const o = jsonObj(text);
  const id = str(o?.delegation_id);
  if (!o || !id) return undefined;
  const tasks = (Array.isArray(o.tasks) ? o.tasks : []).filter(isObj).map((t) => ({
    goal: (str(t.goal) ?? "").replace(/\s+/g, " ").trim(),
    ...(str(t.log) ? { log: str(t.log) } : {}),
    ...(str(t.status) ? { status: str(t.status) } : {}),
  }));
  const startedAt = localMs(o.started);
  const completedAt = localMs(o.completed);
  return {
    id,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    tasks,
  };
}
