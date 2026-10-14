// What an approval card shows, and what we answer. Pure; the webview renders
// the card (slice 4 moved approvals from a modal dialog into the chat).
//
// Hermes asks before file edits (always, in its default mode — and always for
// .git/.ssh/.env paths) and before dangerous commands. Rules, from the review:
//   - The HEADING is written by us. Model-controlled text (the file, the
//     command, the tool title, the diff) is shown as data, after sanitizing:
//     invisible and bidi characters become visible escapes, long text is capped.
//   - Buttons: reject first. The card never takes focus by itself, so a card
//     that appears while the user is typing cannot turn a keystroke into
//     "Allow"; the one path that does focus it (the notification's Show)
//     focuses Deny.
//   - Approval is decided by option.kind, never by matching optionId text.

import type { DiffView } from "../shared/chat";
import { buildDiff } from "./diff";
import { visibleChars } from "./safeText";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequestLike {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string | null;
    kind?: string | null;
    content?: unknown[] | null;
    locations?: { path: string; line?: number | null }[] | null;
    rawInput?: unknown;
  };
  options: PermissionOption[];
}

export type PermissionResponse =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

export const selected = (optionId: string): PermissionResponse => ({
  outcome: { outcome: "selected", optionId },
});
export const cancelled = (): PermissionResponse => ({ outcome: { outcome: "cancelled" } });

export const isAllowKind = (kind: string): boolean => kind.startsWith("allow");

const DETAIL_MAX = 1500;
const LABEL_MAX = 40;

export { visibleChars };

/** One-line form: newlines shown as ⏎, whitespace runs collapsed. For titles
 *  and commands, where a newline could push the dangerous part out of view. */
export function oneLine(text: string): string {
  return visibleChars(text)
    .replace(/\r?\n/g, " ⏎ ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} chars — full text in the Hermes Studio log)`;
}

/** Deny first, then the allows (in Hermes's order), then "always deny". */
export function orderOptions(options: readonly PermissionOption[]): PermissionOption[] {
  const rank = (k: string): number =>
    k === "reject_once" ? 0 : isAllowKind(k) ? 1 : k === "reject_always" ? 2 : 3;
  return options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o.kind) - rank(b.o.kind) || a.i - b.i)
    .map((x) => x.o);
}

export interface DiffBlock {
  path: string;
  oldText?: string;
  newText: string;
}

/** The first ACP diff block in tool-call content. */
export function findDiff(content: readonly unknown[] | null | undefined): DiffBlock | undefined {
  for (const c of content ?? []) {
    if (typeof c !== "object" || c === null) continue;
    const b = c as Record<string, unknown>;
    if (b.type === "diff" && typeof b.path === "string" && typeof b.newText === "string") {
      return {
        path: b.path,
        newText: b.newText,
        ...(typeof b.oldText === "string" ? { oldText: b.oldText } : {}),
      };
    }
  }
  return undefined;
}

/** The text blocks in tool-call content (raw: callers sanitize for display). */
export function contentTexts(content: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  for (const c of content ?? []) {
    if (typeof c !== "object" || c === null) continue;
    const b = c as Record<string, unknown>;
    // ToolCallContent "content" wraps a ContentBlock.
    const inner = b.type === "content" ? (b.content as Record<string, unknown> | undefined) : b;
    if (inner && inner.type === "text" && typeof inner.text === "string") out.push(inner.text);
  }
  return out;
}

export interface PermissionCard {
  action: "edit" | "command" | "other";
  heading: string;
  target?: string;
  detail?: string;
  diff?: DiffView;
  files?: number;
  options: { optionId: string; label: string; kind: string }[];
  /** The full texts behind the card's diff, for "Open diff" (host only). */
  fullDiff?: { path: string; oldText: string; newText: string };
}

/** The in-chat approval card: our heading, sanitized and capped model text,
 *  Deny first, and the whole diff (folded) rather than a short preview. */
export function describeCard(req: PermissionRequestLike): PermissionCard {
  const tc = req.toolCall;
  const kind = tc.kind ?? "";
  const title = oneLine(tc.title ?? "");
  const diff = findDiff(tc.content);
  const texts = contentTexts(tc.content).map(oneLine).filter(Boolean);

  const raw = (
    typeof tc.rawInput === "object" && tc.rawInput !== null ? tc.rawInput : {}
  ) as Record<string, unknown>;

  let action: PermissionCard["action"];
  let heading: string;
  let target: string | undefined;
  let files: number | undefined;
  let extra: string[];
  if (kind === "edit" || diff) {
    action = "edit";
    const path = diff?.path ?? tc.locations?.[0]?.path ?? title.replace(/^Approve edit:\s*/i, "");
    // A V4A multi-file patch names its files comma-joined.
    const list = path.split(/,\s*/).filter(Boolean);
    if (list.length > 1) files = list.length;
    target = cap(oneLine(path), 300) || undefined;
    heading = list.length > 1 ? `Edit ${list.length} files` : "Edit";
    // The title only repeats the file ("Approve edit: src/a.ts").
    extra = texts;
  } else if (kind === "execute") {
    action = "command";
    heading = "Run a command";
    // The exact command: Hermes's raw input, else its "$ <command>" line.
    const dollar = contentTexts(tc.content)
      .flatMap((t) => t.split(/\r?\n/))
      .find((l) => l.startsWith("$ "));
    const command = typeof raw.command === "string" ? raw.command : (dollar?.slice(2) ?? title);
    target = cap(oneLine(command), 1500) || undefined;
    // Why Hermes flagged it ("recursive delete"), when it says.
    extra = typeof raw.description === "string" ? [oneLine(raw.description)] : title ? [title] : [];
  } else {
    action = "other";
    heading = "Allow this?";
    extra = [title, ...texts];
  }

  const shownExtra = extra.filter((t) => t && t !== target);
  const detail = shownExtra.length > 0 ? cap(shownExtra.join("\n\n"), DETAIL_MAX) : undefined;

  const options = orderOptions(req.options).map((o) => ({
    label: cap(oneLine(o.name) || o.optionId, LABEL_MAX).replace(/… \(.*$/, "…"),
    optionId: o.optionId,
    kind: o.kind,
  }));

  return {
    action,
    heading,
    ...(target ? { target } : {}),
    ...(detail ? { detail } : {}),
    ...(files ? { files } : {}),
    ...(diff
      ? {
          diff: buildDiff(diff.path, diff.oldText, diff.newText),
          fullDiff: { path: diff.path, oldText: diff.oldText ?? "", newText: diff.newText },
        }
      : {}),
    options,
  };
}
