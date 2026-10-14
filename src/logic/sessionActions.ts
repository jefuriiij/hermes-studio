// Rename and delete a saved session, through Hermes's own CLI (ACP has
// neither): `hermes sessions rename` / `hermes sessions delete --yes`. Pure.
//
// Hermes 0.21.5 (hermes_cli/sessions_cmd.py, hermes_state_titles.py):
// - rename: the title is cleaned (control and invisible characters dropped,
//   whitespace collapsed), must not be empty, at most 100 characters, and
//   UNIQUE ("Title '…' is already in use by session …"). Exit 1 on an error.
// - delete: removes the session and all its messages; no undo, no archive
//   for one session. The id is resolved by PREFIX, so only a full id from
//   the list may be passed. `--` ends the options: a title or an id can never
//   be read as a flag.

export const MAX_TITLE = 100;

export type TitleCheck = { ok: true; title: string } | { ok: false; error: string };

/** Control, zero-width and bidi characters, as code-point ranges: Hermes
 *  drops them too. (Numbers, not a regex: a formatter once turned the
 *  regex's escapes into the invisible characters themselves.) */
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x7f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isInvisible(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return INVISIBLE.some(([from, to]) => c >= from && c <= to);
}

/** The title Hermes will store, or why it would refuse it. */
export function cleanTitle(raw: string): TitleCheck {
  const visible = [...raw].map((ch) => (isInvisible(ch) ? " " : ch)).join("");
  const title = visible.replace(/\s+/g, " ").trim();
  if (!title) return { ok: false, error: "The name cannot be empty." };
  if (title.length > MAX_TITLE) {
    return {
      ok: false,
      error: `The name is too long (${title.length} characters, at most ${MAX_TITLE}).`,
    };
  }
  return { ok: true, title };
}

export function renameArgs(sessionId: string, title: string): string[] {
  return ["sessions", "rename", "--", sessionId, title];
}

export function deleteArgs(sessionId: string): string[] {
  return ["sessions", "delete", "--yes", "--", sessionId];
}

/** Hermes's own reason, in our words where we know it. */
export function failureText(stdout: string, stderr: string): string {
  const all = `${stdout}\n${stderr}`;
  if (/already in use by session/i.test(all)) return "Another session already has that name.";
  if (/not found|no session/i.test(all)) return "Hermes no longer has that session.";
  if (/too long/i.test(all)) return `The name is too long (at most ${MAX_TITLE} characters).`;
  const line = all
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^error/i.test(l));
  return line
    ? line.replace(/^error:\s*/i, "").slice(0, 200)
    : "Hermes could not do it. See the log.";
}
