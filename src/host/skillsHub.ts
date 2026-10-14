// "Get more" skills (mock board 28): search the Skills Hub and install from
// it with Hermes's own commands (logic/skillsHub.ts). Only identifiers from
// an answer this service gave can be installed. No vscode import: tests drive
// it with a fake runner.

import { installArgs, parseHubResults, parseInstallOutput, searchArgs } from "../logic/skillsHub";
import type { HubSkill } from "../shared/panels";
import type { RunResult } from "./accountUsage";

export type HubRun = (args: readonly string[], timeoutMs: number) => Promise<RunResult>;

export interface SkillsHubDeps {
  /** Runs `hermes <args>`; undefined when Hermes is not found. */
  run: () => HubRun | undefined;
  publishResults: (r: { seq: number; items: HubSkill[]; error?: string }) => void;
  publishInstalled: (r: { identifier: string; ok: boolean; message?: string }) => void;
  /** Read Hermes's files again: the new skill shows under Installed. */
  refresh: () => void;
  log: (line: string) => void;
  now: () => number;
}

/** A search takes 1–3 s and the hub changes slowly. */
const CACHE_MS = 10 * 60_000;
const SEARCH_MS = 45_000;
/** Fetch + quarantine + scan: can take a while on a big skill. */
const INSTALL_MS = 180_000;

export class SkillsHub {
  private readonly cache = new Map<string, { at: number; items: HubSkill[] }>();
  /** Every identifier an answer offered: the only ones that can be installed. */
  private readonly offered = new Set<string>();
  private installing?: string;

  constructor(private readonly deps: SkillsHubDeps) {}

  async search(query: string, official: boolean, seq: number): Promise<void> {
    const q = query.trim();
    if (!q && !official) return this.deps.publishResults({ seq, items: [] });
    const key = `${official ? "official" : "all"}\n${q.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && this.deps.now() - hit.at < CACHE_MS) {
      return this.deps.publishResults({ seq, items: hit.items });
    }
    const run = this.deps.run();
    if (!run) return this.deps.publishResults({ seq, items: [], error: "Hermes was not found." });
    const r = await run(searchArgs(q, official), SEARCH_MS);
    const items = r.code === 0 ? parseHubResults(r.stdout) : undefined;
    if (!items) {
      this.deps.log(`[ext] hermes skills search: ${(r.stderr || r.stdout).trim().slice(-300)}`);
      return this.deps.publishResults({
        seq,
        items: [],
        error:
          r.code === null
            ? "The Skills Hub did not answer in time."
            : "The Skills Hub couldn't be searched.",
      });
    }
    for (const s of items) this.offered.add(s.identifier);
    this.cache.set(key, { at: this.deps.now(), items });
    this.deps.publishResults({ seq, items });
  }

  async install(identifier: string): Promise<void> {
    const done = (ok: boolean, message?: string) =>
      this.deps.publishInstalled({ identifier, ok, ...(message ? { message } : {}) });
    if (!this.offered.has(identifier)) return done(false, "Search for it again first.");
    if (this.installing) return done(false, "One install at a time: wait for the other one.");
    const run = this.deps.run();
    if (!run) return done(false, "Hermes was not found.");
    this.installing = identifier;
    try {
      const r = await run(installArgs(identifier), INSTALL_MS);
      const outcome = parseInstallOutput(r.stdout, r.stderr, r.code);
      this.deps.log(
        `[ext] hermes skills install ${identifier}: ${outcome.ok ? "installed" : outcome.message}`,
      );
      if (outcome.ok) done(true);
      else done(false, outcome.message);
    } finally {
      this.installing = undefined;
      this.deps.refresh();
    }
  }
}
