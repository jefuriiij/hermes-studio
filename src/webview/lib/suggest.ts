// The composer's "/" and "@" lists: what they offer for what was typed. Pure,
// and imported by relative path (not $shared) so the main test suite can load it.

import type { SlashCommand } from "../../shared/chat";

export interface Suggestion {
  kind: "skill" | "command" | "file" | "folder";
  /** A skill's or command's name (no "/"), or a workspace path. */
  name: string;
  detail?: string;
}

/** Hermes's command slug for a skill name ("Foo Bar" → "foo-bar"), as its
 *  terminal writes `/foo-bar` (agent/skill_commands.py slugify_skill_name). */
export function skillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[ _]/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function score(name: string, detail: string | undefined, q: string): number {
  if (!q) return 1;
  const n = name.toLowerCase();
  if (n.startsWith(q) || skillSlug(name).startsWith(q)) return 3;
  if (n.includes(q)) return 2;
  // One or two letters are in nearly every description: names only until three.
  return q.length >= 3 && detail?.toLowerCase().includes(q) ? 1 : 0;
}

/** Skills first (the "/" menu is for skills), then Hermes's own commands. */
export function slashSuggestions(
  skills: readonly { name: string; description?: string }[],
  commands: readonly SlashCommand[],
  query: string,
  limits = { skills: 8, commands: 5 },
): { skills: Suggestion[]; commands: Suggestion[]; skillMatches: number } {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const ranked: { s: Suggestion; score: number }[] = [];
  for (const k of skills) {
    if (seen.has(k.name)) continue;
    seen.add(k.name);
    const sc = score(k.name, k.description, q);
    if (sc > 0) {
      ranked.push({
        s: { kind: "skill", name: k.name, ...(k.description ? { detail: k.description } : {}) },
        score: sc,
      });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  const cmds = commands
    .map((c) => ({ c, sc: score(c.name, c.description, q) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc || a.c.name.localeCompare(b.c.name))
    .slice(0, limits.commands)
    .map(({ c }) => ({
      kind: "command" as const,
      name: c.name,
      ...(c.description ? { detail: c.description } : {}),
    }));
  return {
    skills: ranked.slice(0, limits.skills).map((r) => r.s),
    commands: cmds,
    skillMatches: ranked.length,
  };
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function dirName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "" : trimmed.slice(0, i);
}

/** The "@query" right before the caret, if the caret is in one. `start` is the
 *  index of the "@". An e-mail address (text right before the "@") is not one. */
export function mentionAt(
  text: string,
  caret: number,
): { start: number; query: string } | undefined {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return undefined;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** The skill a typed "/word" names (by name or slug), or undefined. */
function skillNamed(word: string, skills: readonly { name: string }[]): string | undefined {
  const w = word.toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === w || skillSlug(s.name) === w)?.name;
}

/**
 * The skills a message names as "/name", anywhere in it (after white space,
 * or at the start), in order and once each. A word at the very start that is
 * one of Hermes's commands stays a command.
 */
export function skillsIn(
  text: string,
  skills: readonly { name: string }[],
  commands: readonly SlashCommand[] = [],
): string[] {
  const out: string[] = [];
  const re = /(^|\s)\/([^\s/]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const word = (m[2] ?? "").replace(/[.,;:!?)\]]+$/, "");
    const atStart = m.index === 0 && !m[1];
    if (atStart && commands.some((c) => c.name.toLowerCase() === word.toLowerCase())) continue;
    const name = skillNamed(word, skills);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Text cut into plain runs, "@path" mentions and "/skill" names (mock board
 *  19B: both show in Hermes gold). A mention starts the text or follows white
 *  space, as "@" does in the list, so an e-mail address is not one; a "/word"
 *  counts only when it names one of `skills`. */
export function mentionSegments(
  text: string,
  skills: readonly { name: string }[] = [],
): { text: string; mention: boolean }[] {
  const out: { text: string; mention: boolean }[] = [];
  const re = /(^|\s)(@[^\s@]+|\/[^\s/]+)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let token = m[2] ?? "";
    if (token.startsWith("/")) {
      // Punctuation after the name ("/emil-design-eng,") is plain text.
      const bare = token.replace(/[.,;:!?)\]]+$/, "");
      if (!skillNamed(bare.slice(1), skills)) continue;
      token = bare;
    }
    const start = m.index + (m[1] ?? "").length;
    if (start > at) out.push({ text: text.slice(at, start), mention: false });
    out.push({ text: token, mention: true });
    at = start + token.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), mention: false });
  return out;
}

/** The "/query" the caret is in: at the start of the message (skills and
 *  Hermes's commands), or after a space mid-text (skills only). */
export function slashAt(
  text: string,
  caret: number,
): { query: string; start: number; atStart: boolean } | undefined {
  // At the start, or after white space (a path like src/app or a URL is not one).
  const before = text.slice(0, caret);
  const m = /(^|\s)\/([^\s/]*)$/.exec(before);
  if (!m) return undefined;
  const query = m[2] ?? "";
  const start = caret - query.length - 1;
  // Hermes runs a command only as the whole message: mid-text, skills only.
  return { query, start, atStart: start === 0 };
}
