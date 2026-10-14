// Subscription limits for the model menu: runs `hermes usage --provider <slug>
// --json` once per provider when the menu opens, unless a recent answer is
// cached. No vscode import: tests drive it with a fake runner.

import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { hasAnthropicPercentBug, parseAccountUsage, providerSlug } from "../logic/accountUsage";
import type { AccountUsage, ProviderUsage } from "../shared/protocol";

/** Usage changes as you work: re-read after a minute. */
const FRESH_MS = 60_000;
/** "No usage for this provider" rarely changes: ask again after 10 minutes. */
const NONE_MS = 10 * 60_000;
/** Each fetch takes ~1.5 s; Hermes's own HTTP timeout is 15 s. */
const TIMEOUT_MS = 25_000;
const MAX_STDOUT = 1_000_000;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type UsageRunner = (slug: string) => Promise<RunResult>;

export interface AccountUsageDeps {
  publish: (usage: AccountUsage) => void;
  log: (line: string) => void;
  now: () => number;
  /** Runs the command for one provider; undefined when Hermes is not found. */
  runner: () => UsageRunner | undefined;
  /** Applied on every publish (the Hermes bug correction, which depends on
   *  whether the chat just hit a limit). */
  adjust?: (slug: string, usage: ProviderUsage) => ProviderUsage;
}

export class AccountUsageService {
  private readonly cache = new Map<string, { at: number; usage: ProviderUsage | null }>();
  private readonly inflight = new Set<string>();

  constructor(private readonly deps: AccountUsageDeps) {}

  get snapshot(): AccountUsage {
    const byProvider: Record<string, ProviderUsage | null> = {};
    for (const [slug, c] of this.cache) {
      byProvider[slug] = c.usage && this.deps.adjust ? this.deps.adjust(slug, c.usage) : c.usage;
    }
    return { byProvider, loading: [...this.inflight] };
  }

  /** Fetch what is missing or stale for these providers; publishes now (what
   *  is cached, adjusted for the current chat) and as each fetch lands.
   *  `force`: read again even if fresh (the chat just hit a limit). */
  refresh(slugs: readonly string[], force = false): void {
    const run = this.deps.runner();
    if (!run) return;
    let started = false;
    for (const slug of slugs) {
      if (providerSlug(slug) !== slug || this.inflight.has(slug)) continue;
      const c = this.cache.get(slug);
      if (!force && c && this.deps.now() - c.at < (c.usage ? FRESH_MS : NONE_MS)) continue;
      this.inflight.add(slug);
      started = true;
      void this.fetch(run, slug);
    }
    if (started || this.cache.size > 0) this.deps.publish(this.snapshot);
  }

  private async fetch(run: UsageRunner, slug: string): Promise<void> {
    let usage: ProviderUsage | null = null;
    try {
      const r = await run(slug);
      if (r.code === 0) usage = parseAccountUsage(r.stdout) ?? null;
      else {
        const why = r.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) || `exit ${r.code}`;
        this.deps.log(`[ext] hermes usage --provider ${slug}: ${why}`);
      }
    } catch (e) {
      this.deps.log(`[ext] hermes usage --provider ${slug} failed: ${String(e)}`);
    }
    this.cache.set(slug, { at: this.deps.now(), usage });
    this.inflight.delete(slug);
    this.deps.publish(this.snapshot);
  }
}

/** The real runner: `<hermes> usage --provider <slug> --json`, no shell. */
export function hermesUsageRunner(command: string, env: Record<string, string>): UsageRunner {
  return (slug) => runHermes(command, env, ["usage", "--provider", slug, "--json"]);
}

/** One short Hermes CLI command, no shell, killed (with its Python child)
 *  if it outlives the timeout. */
export function runHermes(
  command: string,
  env: Record<string, string>,
  args: readonly string[],
  timeoutMs = TIMEOUT_MS,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: homedir(),
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (s: string) => {
      if (stdout.length < MAX_STDOUT) stdout += s;
    });
    child.stderr.on("data", (s: string) => {
      if (stderr.length < 10_000) stderr += s;
    });
    const timer = setTimeout(() => {
      stderr = `timed out after ${timeoutMs / 1000} s`;
      killTree(child.pid, () => child.kill());
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** hermes.exe is a launcher with a Python child: on Windows, kill the tree. */
function killTree(pid: number | undefined, fallback: () => void): void {
  if (process.platform !== "win32" || pid === undefined) {
    fallback();
    return;
  }
  const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  execFile(
    taskkill,
    ["/PID", String(pid), "/T", "/F"],
    { windowsHide: true, timeout: 2000 },
    (err) => {
      if (err) fallback();
    },
  );
}

/**
 * Whether the installed Hermes still has bug #58226 (Anthropic 1% shown as
 * 100%), read from its own source so the correction ends with the fix. The
 * file is re-read only when it changes (a `hermes update`).
 */
export class AnthropicPercentBugCheck {
  present = false;
  private seen?: { file: string; mtimeMs: number; present: boolean };
  /** From `hermes --version` when the usual layout is not there; null: unknown. */
  private installDir?: string | null;

  constructor(
    private readonly hermes: () => { command: string; env: Record<string, string> } | undefined,
    private readonly log: (line: string) => void,
  ) {}

  async update(): Promise<void> {
    const h = this.hermes();
    const file = h ? await this.sourceFile(h) : undefined;
    if (!file) {
      this.present = false;
      return;
    }
    try {
      const { mtimeMs } = await stat(file);
      if (this.seen?.file !== file || this.seen.mtimeMs !== mtimeMs) {
        const present = hasAnthropicPercentBug(await readFile(file, "utf8"));
        if (present && !this.seen?.present) {
          this.log("[ext] this Hermes shows Anthropic 1% as 100% (bug #58226): correcting it");
        }
        this.seen = { file, mtimeMs, present };
      }
      this.present = this.seen.present;
    } catch {
      this.present = false;
    }
  }

  private async sourceFile(h: { command: string; env: Record<string, string> }) {
    const rel = path.join("agent", "account_usage.py");
    // The Windows installer: <root>/bin/hermes.exe next to <root>/hermes-agent.
    const usual = path.join(path.dirname(path.dirname(h.command)), "hermes-agent", rel);
    if (await exists(usual)) return usual;
    if (this.installDir === undefined) this.installDir = (await installDir(h)) ?? null;
    return this.installDir ? path.join(this.installDir, rel) : undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** "Install directory: C:\…\hermes-agent" from `hermes --version`. */
function installDir(h: {
  command: string;
  env: Record<string, string>;
}): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      h.command,
      ["--version"],
      { env: h.env, windowsHide: true, timeout: 15_000 },
      (err, stdout) => {
        const m = err ? null : /^Install directory:\s*(.+?)\s*$/m.exec(String(stdout));
        resolve(m?.[1]);
      },
    );
  });
}
