// "Get more" skills in the Capabilities tab (mock board 28), through Hermes's
// own hub commands (hermes_cli/skills_hub.py): `hermes skills search <q>
// --json` prints a clean JSON array for scripting; `hermes skills install
// <identifier> --yes` fetches, quarantines, SCANS and installs without a
// prompt — the scan still blocks a dangerous skill (should_allow_install
// without --force; we never pass --force). Pure: no vscode, no processes.

import type { HubSkill } from "../shared/panels";
import { HUB_IDENTIFIER } from "../shared/protocol";

const LIMIT = 30;

/** Empty + official: Hermes's own optional skills (a browse). `--` ends the
 *  flags, so a query starting with "-" stays a query. */
export function searchArgs(query: string, official: boolean): string[] {
  return [
    "skills",
    "search",
    "--json",
    "--limit",
    String(LIMIT),
    ...(official ? ["--source", "official"] : []),
    "--",
    query.trim(),
  ];
}

export function installArgs(identifier: string): string[] {
  return ["skills", "install", "--yes", "--", identifier];
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : undefined;

/** The JSON array `search --json` prints (name, identifier, source,
 *  trust_level, description); rows without a usable identifier are dropped. */
export function parseHubResults(stdout: string): HubSkill[] | undefined {
  const start = stdout.indexOf("[");
  if (start < 0) return undefined;
  let rows: unknown;
  try {
    rows = JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  const out: HubSkill[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const identifier = str(o.identifier, 300);
    const name = str(o.name, 120);
    if (!identifier || !name || !HUB_IDENTIFIER.test(identifier) || seen.has(identifier)) continue;
    seen.add(identifier);
    const source = str(o.source, 40) ?? "";
    const description = str(o.description, 400);
    out.push({
      name,
      identifier,
      source,
      trust:
        source === "official" ? "official" : o.trust_level === "trusted" ? "trusted" : "community",
      ...(description ? { description } : {}),
    });
  }
  return out;
}

/** Rich's colours and box lines, gone. */
export function plainText(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/[╭╮╰╯│─━┃]+/g, " ");
}

export type InstallOutcome = { ok: true } | { ok: false; message: string };

/**
 * What `skills install` printed (do_install): "Installed: <path>" on success;
 * "Not installed: …" or "Installation blocked" when the scan refuses it;
 * "is already installed" (we never force); a fetch failure otherwise.
 */
export function parseInstallOutput(
  stdout: string,
  stderr: string,
  code: number | null,
): InstallOutcome {
  const text = plainText(`${stdout}\n${stderr}`);
  if (/^\s*Installed:/m.test(text)) return { ok: true };
  if (/is already installed/.test(text)) return { ok: false, message: "It's installed already." };
  const blocked = /(?:Not installed:|blocked)[^\n]*/i.exec(text)?.[0];
  if (blocked) {
    return { ok: false, message: "Not installed: Hermes's safety check found risky code in it." };
  }
  // _print_error: "Error: <why>"; a fetch that failed says so too.
  const reason =
    /Error:\s*([^\n]+)/.exec(text)?.[1]?.trim().slice(0, 200) ??
    /(?:failed|could not)[^\n]*/i.exec(text)?.[0]?.trim().slice(0, 200) ??
    (code === null ? "Hermes did not finish in time." : "");
  return { ok: false, message: reason ? `Not installed: ${reason}` : "Not installed." };
}
