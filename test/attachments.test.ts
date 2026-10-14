import { describe, expect, it } from "vitest";

import {
  type Attachment,
  capText,
  diffFileCount,
  gitDiffText,
  imageDimensions,
  type Problem,
  problemsText,
  promptBlocks,
  RecentImages,
  selectionText,
  editorContextText,
  EDITOR_SELECTION_MAX,
} from "../src/logic/attachments";
import { isWebviewToHost } from "../src/shared/protocol";

describe("selectionText", () => {
  it("names the file and lines, fenced with the language", () => {
    expect(selectionText("src/a.ts", 3, 5, "typescript", "const x = 1;")).toBe(
      "[Selected code from src/a.ts, lines 3–5]\n```typescript\nconst x = 1;\n```",
    );
    expect(selectionText("a.py", 7, 7, "python", "x")).toMatch(
      /^\[Selected code from a\.py, line 7\]/,
    );
  });

  it("uses a fence longer than any backtick run inside, so the code cannot close it", () => {
    const code = "text\n```\nnot the end\n````";
    const out = selectionText("README.md", 1, 4, "markdown", code);
    expect(out.split("\n")[1]).toBe("`````markdown");
    expect(out.endsWith("\n`````")).toBe(true);
  });

  it("drops a language id that could break the fence line", () => {
    expect(selectionText("x", 1, 1, "a b\n", "y").split("\n")[1]).toBe("```");
  });
});

describe("capText", () => {
  it("keeps short text and says how much was left out of long text", () => {
    expect(capText("abc", 5)).toBe("abc");
    expect(capText("abcdefgh", 5)).toBe("abcde\n… (3 more characters left out)");
  });
});

describe("problemsText", () => {
  const p = (
    path: string,
    line: number,
    severity: Problem["severity"],
    message: string,
    source?: string,
  ): Problem => ({
    path,
    line,
    column: 2,
    severity,
    message,
    ...(source ? { source } : {}),
  });

  it("lists errors first, then warnings, one line each", () => {
    const out = problemsText([
      p("b.ts", 9, "warning", "unused  x"),
      p("a.ts", 4, "error", "Type 'string' is not\nassignable", "ts"),
      p("a.ts", 1, "error", "missing ;"),
    ]);
    expect(out).toBe(
      [
        "[Problems reported by VS Code: 2 errors, 1 warning]",
        "- a.ts:1:2 error: missing ;",
        "- a.ts:4:2 error: Type 'string' is not assignable (ts)",
        "- b.ts:9:2 warning: unused x",
      ].join("\n"),
    );
  });

  it("stops at 100 and says how many more", () => {
    const many = Array.from({ length: 130 }, (_, i) => p("a.ts", i + 1, "warning", "w"));
    const out = problemsText(many);
    expect(out.split("\n")).toHaveLength(1 + 100 + 1);
    expect(out.endsWith("… and 30 more")).toBe(true);
  });
});

describe("git diff", () => {
  const DIFF = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/y.ts b/y.ts",
    "",
  ].join("\n");

  it("counts the files and fences the diff", () => {
    expect(diffFileCount(DIFF)).toBe(2);
    const out = gitDiffText(DIFF);
    expect(out.startsWith("[Uncommitted git changes: 2 files]\n```diff\ndiff --git a/x.ts")).toBe(
      true,
    );
    expect(out.endsWith("diff --git a/y.ts b/y.ts\n```")).toBe(true);
  });
});

describe("imageDimensions", () => {
  const bytes = (...parts: (number[] | string)[]) =>
    Uint8Array.from(
      parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)),
    );
  const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
  const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
  const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

  it("reads PNG", () => {
    const png = bytes(
      [0x89],
      "PNG",
      [0x0d, 0x0a, 0x1a, 0x0a],
      u32be(13),
      "IHDR",
      u32be(461),
      u32be(398),
      [8, 6, 0, 0, 0],
    );
    expect(imageDimensions(png)).toEqual({ width: 461, height: 398 });
    // The real 1×1 PNG a paste test uses.
    const real = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    expect(imageDimensions(real)).toEqual({ width: 1, height: 1 });
  });

  it("reads GIF", () => {
    expect(imageDimensions(bytes("GIF89a", u16le(640), u16le(480), [0, 0, 0]))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("reads JPEG past the APP segments to the frame header", () => {
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe0],
      u16be(16),
      "JFIF",
      [0],
      Array(9).fill(0),
      [0xff, 0xff], // a fill byte
      [0xff, 0xc4],
      u16be(4),
      [0, 0], // a Huffman table is not a frame
      [0xff, 0xc2],
      u16be(17),
      [8],
      u16be(1080),
      u16be(1920),
      Array(12).fill(0),
    );
    expect(imageDimensions(jpeg)).toEqual({ width: 1920, height: 1080 });
  });

  it("reads the three WebP forms", () => {
    const riff = (chunk: string, body: number[]) =>
      bytes("RIFF", u32be(0), "WEBP", chunk, u32be(0), body);
    const vp8x = riff("VP8X", [0, 0, 0, 0, ...u24le(799), ...u24le(599)]);
    expect(imageDimensions(vp8x)).toEqual({ width: 800, height: 600 });
    const vp8 = riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(320), ...u16le(240), 0, 0]);
    expect(imageDimensions(vp8)).toEqual({ width: 320, height: 240 });
    const bits = (100 - 1) | ((50 - 1) << 14);
    const vp8l = riff("VP8L", [
      0x2f,
      bits & 255,
      (bits >>> 8) & 255,
      (bits >>> 16) & 255,
      (bits >>> 24) & 255,
      0,
      0,
      0,
      0,
      0,
    ]);
    expect(imageDimensions(vp8l)).toEqual({ width: 100, height: 50 });
  });

  it("gives up on anything else, or on a cut-off header", () => {
    expect(imageDimensions(bytes("hello world, not an image"))).toBeUndefined();
    expect(imageDimensions(bytes([0x89], "PNG"))).toBeUndefined();
    expect(imageDimensions(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBeUndefined();
    expect(imageDimensions(new Uint8Array())).toBeUndefined();
  });
});

describe("RecentImages", () => {
  const img = (data: string) => ({ label: "Pasted image", mimeType: "image/png", data });

  it("keeps the newest images within the count", () => {
    const r = new RecentImages(2, 1000);
    r.add("a", img("AAAA"));
    r.add("b", img("BBBB"));
    r.add("c", img("CCCC"));
    expect(r.get("a")).toBeUndefined();
    expect(r.get("b")?.data).toBe("BBBB");
    expect(r.get("c")?.data).toBe("CCCC");
  });

  it("drops the oldest to stay within the size, but never the one just added", () => {
    const r = new RecentImages(10, 10);
    r.add("a", img("AAAA"));
    r.add("b", img("BBBB"));
    r.add("c", img("CCCC")); // 12 > 10: a goes
    expect(r.get("a")).toBeUndefined();
    expect(r.get("b")).toBeDefined();
    r.add("huge", img("X".repeat(50)));
    expect(r.get("b")).toBeUndefined();
    expect(r.get("huge")).toBeDefined();
  });

  it("re-adding an id replaces it", () => {
    const r = new RecentImages(2, 1000);
    r.add("a", img("AAAA"));
    r.add("a", img("ZZZZ"));
    r.add("b", img("BBBB"));
    expect(r.get("a")?.data).toBe("ZZZZ");
    expect(r.get("b")).toBeDefined();
  });
});

describe("editorContextText (the file you are in)", () => {
  it("names the file and line, and says it may be unrelated", () => {
    expect(editorContextText("src/auth/login.ts", 44)).toBe(
      "[VS Code: the user is working in src/auth/login.ts, line 44. It may or may not be related to the request.]",
    );
  });

  it("sends a selection with its lines and text, fenced", () => {
    const out = editorContextText("src/auth/login.ts", 52, {
      startLine: 40,
      endLine: 52,
      languageId: "typescript",
      text: "return raw;",
    });
    expect(out.split("\n")).toEqual([
      "[VS Code: the user has lines 40–52 of src/auth/login.ts selected. It may or may not be related to the request.]",
      "```typescript",
      "return raw;",
      "```",
    ]);
    const one = editorContextText("a.py", 3, {
      startLine: 3,
      endLine: 3,
      languageId: "python",
      text: "x",
    });
    expect(one).toMatch(/has line 3 of a\.py selected/);
  });

  it("keeps a riding-along selection small", () => {
    const big = "x".repeat(EDITOR_SELECTION_MAX + 50);
    const out = editorContextText("a.txt", 1, {
      startLine: 1,
      endLine: 900,
      languageId: "plaintext",
      text: big,
    });
    expect(out).toContain("… (50 more characters left out)");
  });
});

describe("promptBlocks", () => {
  it("puts the typed text first, then the attachments in order", () => {
    const a: Attachment = {
      id: "ctx~1",
      kind: "selection",
      label: "a.ts 1",
      block: { type: "text", text: "S" },
    };
    const b: Attachment = {
      id: "ctx~2",
      kind: "file",
      label: "b.ts",
      block: { type: "resource_link", uri: "file:///b.ts", name: "b.ts" },
    };
    expect(promptBlocks("hi", [a, b])).toEqual([{ type: "text", text: "hi" }, a.block, b.block]);
    expect(promptBlocks("hi", [])).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("isWebviewToHost: the + menu", () => {
  it("accepts the known kinds only", () => {
    for (const kind of ["file", "selection", "problems", "git", "image"]) {
      expect(isWebviewToHost({ type: "addContext", kind })).toBe(true);
    }
    expect(isWebviewToHost({ type: "addContext", kind: "terminal" })).toBe(false);
    expect(isWebviewToHost({ type: "addContext" })).toBe(false);
  });

  it("takes the current-file toggle and the effort messages", () => {
    expect(isWebviewToHost({ type: "toggleEditorContext" })).toBe(true);
    expect(isWebviewToHost({ type: "refreshEffort" })).toBe(true);
    expect(isWebviewToHost({ type: "setEffort", level: "xhigh" })).toBe(true);
    // Only the five levels the dots offer: nothing else reaches `config set`.
    expect(isWebviewToHost({ type: "setEffort", level: "ultra" })).toBe(false);
    expect(isWebviewToHost({ type: "setEffort", level: "--force" })).toBe(false);
    expect(isWebviewToHost({ type: "setEffort" })).toBe(false);
  });

  it("needs an id to remove or preview", () => {
    expect(isWebviewToHost({ type: "removeContext", id: "ctx~4" })).toBe(true);
    expect(isWebviewToHost({ type: "previewImage", id: "ctx~4" })).toBe(true);
    expect(isWebviewToHost({ type: "previewImage" })).toBe(false);
    expect(isWebviewToHost({ type: "removeContext", id: "" })).toBe(false);
    expect(isWebviewToHost({ type: "removeContext", id: 4 })).toBe(false);
  });

  it("takes a pasted image only as bounded base64 of a known type", () => {
    const ok = { type: "pasteImage", mimeType: "image/png", data: "iVBORw0KGgo=" };
    expect(isWebviewToHost(ok)).toBe(true);
    expect(isWebviewToHost({ ...ok, mimeType: "image/svg+xml" })).toBe(false);
    expect(isWebviewToHost({ ...ok, data: "" })).toBe(false);
    expect(isWebviewToHost({ ...ok, data: "not base64!" })).toBe(false);
    expect(isWebviewToHost({ ...ok, data: "A".repeat(5_000_001) })).toBe(false);
  });
});
