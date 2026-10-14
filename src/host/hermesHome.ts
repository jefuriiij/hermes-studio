// Read Hermes's home folder into one snapshot for the side panels. No
// `vscode` import (tested against a temp folder). Read-only by construction:
// this file only ever opens files for reading, and never auth.json, .env or
// anything else that holds credentials.

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import {
  type CuratorView,
  configuredPlugins,
  curatorView,
  type Delegation,
  type LearnedSkill,
  type McpServer,
  type MemoryEntry,
  type MemoryLimits,
  mcpServers,
  memoryLimits,
  type PendingMemory,
  parseBundled,
  parseConfig,
  parseDelegation,
  parseHubLock,
  parseLedger,
  parsePending,
  parseUsage,
  recentLearning,
  type SkillInfo,
  skillFrontmatter,
  skillSource,
  splitMemory,
} from "../logic/hermesData";

/** Where Hermes keeps its state: HERMES_HOME, else its platform default. */
export function hermesHome(env: NodeJS.ProcessEnv, platform: string, home: string): string {
  const set = env.HERMES_HOME?.trim();
  if (set) return set;
  if (platform === "win32") {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "hermes");
  }
  return path.posix.join(home, ".hermes");
}

export interface HermesSnapshot {
  home: string;
  /** False when the folder does not exist (Hermes not installed or elsewhere). */
  found: boolean;
  learning: LearnedSkill[];
  /** Every ledger event, oldest first (for "All changes"). */
  totalChanges: number;
  firstChangeAt?: number;
  curator: CuratorView;
  memory: {
    notes: MemoryEntry[];
    profile: MemoryEntry[];
    notesChars: number;
    profileChars: number;
    limits: MemoryLimits;
    pending: PendingMemory[];
    notesPath: string;
    profilePath: string;
  };
  skills: SkillInfo[];
  mcp: McpServer[];
  plugins: { enabled: string[]; disabled: string[]; user: string[] };
  delegations: Delegation[];
  readAt: number;
}

async function text(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Sub-folders, links to folders included: a skill folder can be a symlink
 *  or (on Windows) a junction to a folder elsewhere, e.g. ~/.agents/skills —
 *  Hermes follows them, and such an entry is a link, not a directory. */
async function dirs(p: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of entries) {
    if (d.name.startsWith(".")) continue;
    if (d.isDirectory() || (d.isSymbolicLink() && (await isDir(path.join(p, d.name))))) {
      out.push(d.name);
    }
  }
  return out;
}

/** Follows links; a broken link is not a folder. */
async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** skills/<category>/<name>/SKILL.md, or skills/<name>/SKILL.md for a few. */
async function listSkills(
  root: string,
): Promise<{ name: string; category?: string; path: string }[]> {
  const out: { name: string; category?: string; path: string }[] = [];
  for (const top of await dirs(root)) {
    const direct = path.join(root, top, "SKILL.md");
    if (await exists(direct)) {
      out.push({ name: top, path: direct });
      continue;
    }
    for (const sub of await dirs(path.join(root, top))) {
      const p = path.join(root, top, sub, "SKILL.md");
      if (await exists(p)) out.push({ name: sub, category: top, path: p });
    }
  }
  return out;
}

export async function readSnapshot(home: string, now: number): Promise<HermesSnapshot> {
  const found = await exists(home);
  const at = (...p: string[]) => path.join(home, ...p);
  const config = parseConfig(await text(at("config.yaml")));

  const [ledgerText, usageText, bundledText, hubText, stateText, notesText, profileText] =
    await Promise.all([
      text(at("skills", ".curator_ledger.jsonl")),
      text(at("skills", ".usage.json")),
      text(at("skills", ".bundled_manifest")),
      text(at("skills", ".hub", "lock.json")),
      text(at("skills", ".curator_state")),
      text(at("memories", "MEMORY.md")),
      text(at("memories", "USER.md")),
    ]);

  const events = parseLedger(ledgerText ?? "");
  const usage = parseUsage(usageText);
  const bundled = parseBundled(bundledText);
  const hub = parseHubLock(hubText);

  const skills: SkillInfo[] = [];
  for (const s of await listSkills(at("skills"))) {
    const fm = skillFrontmatter((await text(s.path))?.slice(0, 8192) ?? "");
    const name = fm.name ?? s.name;
    skills.push({
      name,
      ...(fm.description ? { description: fm.description } : {}),
      ...(s.category ? { category: s.category } : {}),
      path: s.path,
      source: skillSource(name, hub, bundled, usage),
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const pending: PendingMemory[] = [];
  let pendingFiles: string[] = [];
  try {
    pendingFiles = (await readdir(at("pending", "memory"))).filter((f) => f.endsWith(".json"));
  } catch {
    // no pending folder: nothing waiting
  }
  for (const f of pendingFiles) {
    const p = parsePending(await text(at("pending", "memory", f)));
    if (p) pending.push(p);
  }
  pending.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  const delegations: Delegation[] = [];
  for (const d of await dirs(at("cache", "delegation", "live"))) {
    const del = parseDelegation(await text(at("cache", "delegation", "live", d, "manifest.json")));
    if (del) delegations.push(del);
  }
  delegations.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  const userPlugins = await dirs(at("plugins"));
  const learning = recentLearning(events, now);
  // The files the Learning panel links to must be the skill's CURRENT file:
  // the ledger's path is where it was then (a skill can move or be archived).
  const byName = new Map(skills.map((s) => [s.name, s.path]));
  for (const l of learning) {
    const current = byName.get(l.skill);
    if (current) l.path = current;
  }

  const notes = splitMemory(notesText);
  const profile = splitMemory(profileText);
  const chars = (entries: MemoryEntry[]) => entries.reduce((n, e) => n + e.text.length, 0);

  return {
    home,
    found,
    learning,
    totalChanges: events.length,
    ...(events[0] ? { firstChangeAt: events[0].ts } : {}),
    curator: curatorView(stateText, config),
    memory: {
      notes,
      profile,
      notesChars: chars(notes),
      profileChars: chars(profile),
      limits: memoryLimits(config),
      pending,
      notesPath: at("memories", "MEMORY.md"),
      profilePath: at("memories", "USER.md"),
    },
    skills,
    mcp: mcpServers(config),
    plugins: { ...configuredPlugins(config), user: userPlugins },
    delegations,
    readAt: now,
  };
}

/** The ledger again, whole — only when "All changes" is asked for. */
export async function readLedger(home: string) {
  return parseLedger((await text(path.join(home, "skills", ".curator_ledger.jsonl"))) ?? "");
}

/** A file's content as it was, from Hermes's content-addressed backups
 *  (`.curator_backups/blobs/<sha256>`), for "diff with previous". */
export async function readBlob(home: string, sha256: string): Promise<string | undefined> {
  if (!/^[a-f0-9]{64}$/.test(sha256)) return undefined;
  return text(path.join(home, ".curator_backups", "blobs", sha256));
}
