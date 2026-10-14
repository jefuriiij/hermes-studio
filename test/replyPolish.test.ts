// A better reply (mock board 23): file paths in `code`, the files a reply
// changed, and where a reply's end goes.

import { describe, expect, it } from "vitest";

import type { ChatItem } from "../src/shared/chat";
import { isWebviewToHost } from "../src/shared/protocol";
import { tookText } from "../src/shared/time";
import { changedFiles, pathRef } from "../src/webview/lib/paths";
import { buildRows } from "../src/webview/lib/rows";

describe("which `code` is a path", () => {
  it("a file with a folder or an extension, and an optional line", () => {
    expect(pathRef("pages/contact.html")).toEqual({ path: "pages/contact.html" });
    expect(pathRef("README.md")).toEqual({ path: "README.md" });
    expect(pathRef("src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
    expect(pathRef("src/a.ts:42:7")).toEqual({ path: "src/a.ts", line: 42 });
    expect(pathRef("C:\\Users\\sam\\a.ts")).toEqual({ path: "C:\\Users\\sam\\a.ts" });
  });

  it("not a word, a version, a sentence or a URL", () => {
    for (const t of ["h1", "npm", "1.2.3", "two words.md", "https://x.io/a.html", ".env", "a"]) {
      expect(pathRef(t)).toBeUndefined();
    }
  });

  it("the host is asked in batches of at most 50", () => {
    expect(isWebviewToHost({ type: "checkPaths", paths: ["a.ts"] })).toBe(true);
    expect(isWebviewToHost({ type: "checkPaths", paths: [] })).toBe(false);
    expect(isWebviewToHost({ type: "checkPaths", paths: Array(51).fill("a.ts") })).toBe(false);
    expect(isWebviewToHost({ type: "checkPaths", paths: [3] })).toBe(false);
  });
});

describe("the files a reply changed", () => {
  it("adds up the edits per file, and opens the newest", () => {
    expect(
      changedFiles([
        { id: "t1", diff: { path: "a.html", added: 10, removed: 2 } },
        { id: "t2" },
        { id: "t3", diff: { path: "b.css", added: 4, removed: 0 } },
        { id: "t4", diff: { path: "a.html", added: 1, removed: 1 } },
      ]),
    ).toEqual([
      { path: "a.html", added: 11, removed: 3, toolId: "t4", edits: 2 },
      { path: "b.css", added: 4, removed: 0, toolId: "t3", edits: 1 },
    ]);
  });

  it("how long it took", () => {
    expect(tookText(134_000)).toBe("took 2 min 14 s");
  });
});

describe("a reply's end", () => {
  const user = (id: string, turn: number): ChatItem => ({ kind: "user", id, text: "q", turn });
  const answer = (id: string, turn: number): ChatItem => ({
    kind: "assistant",
    id,
    text: "a",
    turn,
  });
  const notice = (id: string, turn: number): ChatItem => ({
    kind: "notice",
    id,
    level: "info",
    text: "n",
    turn,
  });

  it("follows each answered turn, after a notice that closes it", () => {
    const items = [user("u1", 1), answer("a1", 1), notice("n1", 1), user("u2", 2), answer("a2", 2)];
    expect(buildRows(items, { ends: true }).map((r) => r.key)).toEqual([
      "u1",
      "a1",
      "n1",
      "end:1",
      "u2",
      "a2",
      "end:2",
    ]);
  });

  it("not while the turn still runs, nor for a message Hermes never answered", () => {
    const items = [user("u1", 1), answer("a1", 1), user("u2", 2)];
    expect(buildRows(items, { ends: true }).map((r) => r.key)).toEqual(["u1", "a1", "end:1", "u2"]);
    expect(
      buildRows([...items, answer("a2", 2)], { ends: true, openTurn: 2 }).map((r) => r.key),
    ).toEqual(["u1", "a1", "end:1", "u2", "a2"]);
  });

  it("only when asked (the other callers keep their rows)", () => {
    expect(buildRows([user("u1", 1), answer("a1", 1)]).map((r) => r.key)).toEqual(["u1", "a1"]);
  });
});
