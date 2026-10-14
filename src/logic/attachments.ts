// What the composer's "+" adds to a message, as ACP prompt blocks. Pure.
//
// ACP (every agent must accept): text and resource_link. Hermes 0.21.5 reads a
// resource_link's file itself and inlines it (≤ 512 KB, acp_adapter/content.py),
// and advertises promptCapabilities.image, so images go as image blocks.
// Hermes does NOT advertise embeddedContext, so a selection, the problems list
// and a git diff go as TEXT blocks with a header saying what they are.

export type ContextKind = "file" | "selection" | "problems" | "git" | "image";

/** What the composer shows as a chip (and the bubble after sending). */
export interface ContextChip {
  id: string;
  kind: ContextKind;
  label: string;
  /** Tooltip: a path, a line range, a count. */
  detail?: string;
  /** An image's pixel size, "461×398", shown after the label. */
  size?: string;
}

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string }
  | { type: "image"; mimeType: string; data: string };

/** "editor": the file you are in, added on send (not by the "+"). */
export type AttachmentKind = ContextKind | "editor";

export interface Attachment extends Omit<ContextChip, "kind"> {
  kind: AttachmentKind;
  block: PromptBlock;
  /** The file it came from, so the same file is not sent twice. */
  sourceUri?: string;
}

/** Per text attachment; Hermes caps a file at 512 KB, a message should not be a book. */
export const TEXT_MAX = 100_000;
/** Base64 image data (≈ 3.75 MB of image): providers reject much more. */
export const IMAGE_MAX_BASE64 = 5_000_000;
export const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function capText(text: string, max = TEXT_MAX): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (${text.length - max} more characters left out)`;
}

/** A fence longer than any backtick run inside, so the code cannot close it. */
function fence(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export function selectionText(
  relPath: string,
  startLine: number,
  endLine: number,
  languageId: string,
  text: string,
): string {
  const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  const body = capText(text);
  const f = fence(body);
  const lang = /^[\w#+.-]{1,32}$/.test(languageId) ? languageId : "";
  return `[Selected code from ${relPath}, ${lines}]\n${f}${lang}\n${body}\n${f}`;
}

/** A selection that rides along on its own is kept smaller than one the
 *  user attached on purpose. */
export const EDITOR_SELECTION_MAX = 20_000;

/**
 * The file you are in, as Hermes gets it with every message (like Claude
 * Code's "the user opened …"): the path and line, or the selected lines with
 * their text. Never the whole file — Hermes can read it if it matters.
 */
export function editorContextText(
  relPath: string,
  line: number,
  selection?: { startLine: number; endLine: number; languageId: string; text: string },
): string {
  const note = "It may or may not be related to the request.";
  if (!selection) return `[VS Code: the user is working in ${relPath}, line ${line}. ${note}]`;
  const { startLine, endLine } = selection;
  const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  const body = capText(selection.text, EDITOR_SELECTION_MAX);
  const f = fence(body);
  const lang = /^[\w#+.-]{1,32}$/.test(selection.languageId) ? selection.languageId : "";
  return `[VS Code: the user has ${lines} of ${relPath} selected. ${note}]\n${f}${lang}\n${body}\n${f}`;
}

export interface Problem {
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  source?: string;
}

const PROBLEMS_MAX = 100;

/** Errors first, then warnings; each "path:line:col severity message (source)". */
export function problemsText(problems: readonly Problem[]): string {
  const sorted = [...problems].sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
  const shown = sorted.slice(0, PROBLEMS_MAX);
  const errors = problems.filter((p) => p.severity === "error").length;
  const lines = shown.map(
    (p) =>
      `- ${p.path}:${p.line}:${p.column} ${p.severity}: ${p.message.replace(/\s+/g, " ").trim()}${p.source ? ` (${p.source})` : ""}`,
  );
  const more = sorted.length > shown.length ? [`… and ${sorted.length - shown.length} more`] : [];
  return capText(
    [
      `[Problems reported by VS Code: ${errors} error${errors === 1 ? "" : "s"}, ${problems.length - errors} warning${problems.length - errors === 1 ? "" : "s"}]`,
      ...lines,
      ...more,
    ].join("\n"),
  );
}

/** Files a unified diff touches ("diff --git a/x b/x" headers). */
export function diffFileCount(diff: string): number {
  return (diff.match(/^diff --git /gm) ?? []).length;
}

export function gitDiffText(diff: string): string {
  const body = capText(diff.trimEnd());
  const f = fence(body);
  const n = diffFileCount(diff);
  return `[Uncommitted git changes: ${n} file${n === 1 ? "" : "s"}]\n${f}diff\n${body}\n${f}`;
}

/**
 * Width and height from an image's header, for PNG, GIF, WebP and JPEG.
 * Undefined when the bytes are not one of those or are cut short.
 */
export function imageDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  const u16be = (i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
  const u16le = (i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
  const u24le = (i: number) => u16le(i) | ((b[i + 2] ?? 0) << 16);
  const u32be = (i: number) => u16be(i) * 65536 + u16be(i + 2);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  const ok = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : undefined;

  // PNG: signature, then the IHDR chunk.
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    return ok(u32be(16), u32be(20));
  }
  if (b.length >= 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return ok(u16le(6), u16le(8));
  }
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (chunk === "VP8L") {
      const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8X") return ok(u24le(24) + 1, u24le(27) + 1);
    return undefined;
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1] ?? 0;
      if (marker === 0xff) {
        i++; // fill byte
        continue;
      }
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return ok(u16be(i + 7), u16be(i + 5));
      i += 2 + u16be(i + 2);
    }
  }
  return undefined;
}

export interface StoredImage {
  label: string;
  size?: string;
  mimeType: string;
  data: string;
}

/**
 * The images of sent messages, so their chips still open a preview. Memory
 * only, the newest kept: at most `maxCount` images and `maxChars` of base64.
 */
export class RecentImages {
  private readonly map = new Map<string, StoredImage>();
  private chars = 0;

  constructor(
    private readonly maxCount = 30,
    private readonly maxChars = 60_000_000,
  ) {}

  add(id: string, image: StoredImage): void {
    this.delete(id);
    this.map.set(id, image);
    this.chars += image.data.length;
    // A Map iterates oldest first.
    for (const oldId of this.map.keys()) {
      if (this.map.size <= this.maxCount && this.chars <= this.maxChars) break;
      if (oldId === id) break; // never drop the one just added
      this.delete(oldId);
    }
  }

  get(id: string): StoredImage | undefined {
    return this.map.get(id);
  }

  private delete(id: string): void {
    const old = this.map.get(id);
    if (!old) return;
    this.chars -= old.data.length;
    this.map.delete(id);
  }
}

/** The blocks of a message: its text first, then what was attached, in order. */
export function promptBlocks(text: string, attachments: readonly Attachment[]): PromptBlock[] {
  return [{ type: "text", text }, ...attachments.map((a) => a.block)];
}
