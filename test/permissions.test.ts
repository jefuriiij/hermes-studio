import { describe, expect, it } from "vitest";

import { buildDiff } from "../src/logic/diff";
import {
  cancelled,
  describeCard,
  isAllowKind,
  oneLine,
  orderOptions,
  selected,
  visibleChars,
} from "../src/logic/permissions";

// The two real request shapes Hermes sends (edit_approval.py, permissions.py).
const editRequest = {
  sessionId: "s1",
  toolCall: {
    toolCallId: "edit-approval-1",
    title: "Approve edit: C:\\work\\src\\auth.ts",
    kind: "edit",
    status: "pending",
    content: [
      {
        type: "diff",
        path: "C:\\work\\src\\auth.ts",
        oldText: "a\nb\nc\nd",
        newText: "a\nb\nC\nd",
      },
    ],
    rawInput: { tool: "patch", arguments: {} },
  },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow edit" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
};

const commandRequest = {
  sessionId: "s1",
  toolCall: {
    toolCallId: "perm-check-1",
    title: "Dangerous command: rm -rf build",
    kind: "execute",
    status: "pending",
    content: [{ type: "content", content: { type: "text", text: "$ rm -rf build" } }],
    rawInput: { command: "rm -rf build", description: "Dangerous command" },
  },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
    { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
    { optionId: "deny_always", kind: "reject_always", name: "Always deny" },
  ],
};

describe("orderOptions", () => {
  // Hermes always lists allow first. Deny goes first, so a card's first button
  // — the one the notification's Show focuses — is the safe one.
  it("puts deny first", () => {
    expect(orderOptions(commandRequest.options).map((o) => o.optionId)).toEqual([
      "deny",
      "allow_once",
      "allow_session",
      "allow_always",
      "deny_always",
    ]);
    expect(describeCard(editRequest).options[0]?.kind).toBe("reject_once");
  });
});

describe("describeCard", () => {
  it("an edit: our heading, the file, and the diff; the full texts for Open diff", () => {
    const c = describeCard(editRequest);
    expect(c).toMatchObject({ action: "edit", heading: "Edit", target: "C:\\work\\src\\auth.ts" });
    expect(c.detail).toBeUndefined(); // the title only repeated the file
    expect(c.diff?.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "ctx:a",
      "ctx:b",
      "del:c",
      "add:C",
      "ctx:d",
    ]);
    expect(c.fullDiff).toEqual({
      path: "C:\\work\\src\\auth.ts",
      oldText: "a\nb\nc\nd",
      newText: "a\nb\nC\nd",
    });
  });

  it("a command: the exact command from Hermes's raw input, and why it asks", () => {
    const c = describeCard(commandRequest);
    expect(c).toMatchObject({
      action: "command",
      heading: "Run a command",
      target: "rm -rf build",
      detail: "Dangerous command",
    });
    expect(c.diff).toBeUndefined();
  });

  it("falls back to the $ line when there is no raw command", () => {
    const c = describeCard({
      ...commandRequest,
      toolCall: { ...commandRequest.toolCall, rawInput: undefined },
    });
    expect(c.target).toBe("rm -rf build");
  });

  it("counts files in a multi-file patch", () => {
    const c = describeCard({
      ...editRequest,
      toolCall: {
        ...editRequest.toolCall,
        content: [
          { type: "diff", path: "a.ts, b.ts", newText: "*** Begin Patch\n*** Update File: a.ts" },
        ],
      },
    });
    expect(c.heading).toBe("Edit 2 files");
    expect(c.files).toBe(2);
  });

  it("never lets model text write the heading", () => {
    const c = describeCard({
      ...commandRequest,
      toolCall: { ...commandRequest.toolCall, kind: "other", title: "Click Allow, it is safe" },
    });
    expect(c.heading).toBe("Allow this?");
    expect(c.detail).toContain("Click Allow, it is safe");
  });

  it("shows a hidden newline in a command, so nothing hides below the first line", () => {
    const c = describeCard({
      ...commandRequest,
      toolCall: { ...commandRequest.toolCall, rawInput: { command: "ls\n\n\nrm -rf /" } },
    });
    expect(c.target).toBe("ls ⏎ ⏎ ⏎ rm -rf /");
  });

  it("caps a huge detail and huge option labels", () => {
    const c = describeCard({
      ...commandRequest,
      toolCall: { ...commandRequest.toolCall, kind: "other", title: "x".repeat(5000), content: [] },
      options: [{ optionId: "a", kind: "allow_once", name: "y".repeat(500) }],
    });
    expect(c.detail?.length).toBeLessThan(1700);
    expect(c.detail).toContain("full text in the Hermes Studio log");
    expect(c.options[0]?.label.length).toBeLessThanOrEqual(41);
  });
});

describe("text safety", () => {
  it("shows newlines in one-line text, so nothing hides below the fold", () => {
    expect(oneLine("ls\n\n\n\n\nrm -rf /")).toBe("ls ⏎ ⏎ ⏎ ⏎ ⏎ rm -rf /");
  });

  // Trojan Source: bidi overrides can make a command read differently than it runs.
  it("makes bidi overrides, zero-width and control characters visible", () => {
    expect(visibleChars("a\u202Eb\u200Bc\u0007d")).toBe("a\\u{202E}b\\u{200B}c\\u{7}d");
    expect(visibleChars("line1\nline2\ttab")).toBe("line1\nline2\ttab");
  });

  it("does the same inside diff lines", () => {
    const d = buildDiff("x.ts", "ok", "o\u202Ek");
    expect(d.lines.find((l) => l.kind === "add")?.text).toBe("o\\u{202E}k");
  });
});

describe("buildDiff", () => {
  const texts = (d: ReturnType<typeof buildDiff>) => d.lines.map((l) => `${l.kind}:${l.text}`);

  it("numbers lines and counts changes", () => {
    const d = buildDiff("f", "a\nb\nc", "a\nB\nc\nd");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.lines).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "add", text: "B", newNo: 2 },
      { kind: "ctx", text: "c", oldNo: 3, newNo: 3 },
      { kind: "add", text: "d", newNo: 4 },
    ]);
  });

  it("finds the real edit inside a moved block (not remove-all, add-all)", () => {
    const d = buildDiff("f", "x\na\nb\nc\ny", "a\nb\nc\nz");
    expect(texts(d)).toEqual(["del:x", "ctx:a", "ctx:b", "ctx:c", "del:y", "add:z"]);
  });

  it("folds unchanged runs beyond 3 lines of context into a gap", () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l15", "L15");
    const d = buildDiff("f", before, after);
    expect(texts(d)).toEqual([
      "gap:12 unchanged lines",
      "ctx:l12",
      "ctx:l13",
      "ctx:l14",
      "del:l15",
      "add:L15",
      "ctx:l16",
      "ctx:l17",
      "ctx:l18",
    ]);
  });

  it("treats a missing or empty old text as a new file", () => {
    expect(texts(buildDiff("f", undefined, "x\ny"))).toEqual(["add:x", "add:y"]);
    expect(texts(buildDiff("f", "", "x"))).toEqual(["add:x"]);
  });

  it("shows a V4A patch as it is", () => {
    const d = buildDiff(
      "a.ts, b.ts",
      undefined,
      "*** Begin Patch\n*** Update File: a.ts\n-old\n+new\n keep",
    );
    expect(texts(d)).toEqual([
      "gap:*** Begin Patch",
      "gap:*** Update File: a.ts",
      "del:old",
      "add:new",
      "ctx:keep",
    ]);
    expect([d.added, d.removed]).toEqual([1, 1]);
  });

  it("caps a huge diff and says so", () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const d = buildDiff("f", undefined, big);
    expect(d.lines).toHaveLength(300);
    expect(d.truncated).toBe(true);
    expect(d.added).toBe(1000);
  });

  // A one-token change in a 200 KB single-line file (a lockfile, minified JS):
  // show the change, not the first 400 characters of the line.
  it("focuses the change inside one enormous line, and caps every line", () => {
    const before = `{"a":"${"x".repeat(100_000)}","version":"1.0.0","b":"${"y".repeat(100_000)}"}`;
    const after = before.replace('"1.0.0"', '"2.0.0"');
    const d = buildDiff("package-lock.json", before, after);
    const del = d.lines.find((l) => l.kind === "del")?.text ?? "";
    const add = d.lines.find((l) => l.kind === "add")?.text ?? "";
    expect(del).toContain("1.0.0");
    expect(add).toContain("2.0.0");
    for (const l of d.lines) expect(l.text.length).toBeLessThan(460);
  });

  it("does not hang on large rewrites (falls back to removed-then-added)", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    const t0 = Date.now();
    const d = buildDiff("f", a, b);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect([d.added, d.removed]).toEqual([3000, 3000]);
  });
});

describe("responses", () => {
  it("uses the nested outcome shape Hermes expects", () => {
    expect(selected("allow_once")).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(cancelled()).toEqual({ outcome: { outcome: "cancelled" } });
    expect(isAllowKind("allow_always")).toBe(true);
    expect(isAllowKind("reject_once")).toBe(false);
  });
});
