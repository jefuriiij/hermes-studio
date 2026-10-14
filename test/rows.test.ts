import { describe, expect, it } from "vitest";

import type { ChatItem, ToolStatus } from "../src/shared/chat";
import { usagePercent } from "../src/webview/lib/format";
import {
  buildRows,
  countTools,
  currentActivity,
  describeCounts,
  formatElapsed,
  parseToolTitle,
  type ToolEntry,
} from "../src/webview/lib/rows";

const user = (id: string, turn: number): ChatItem => ({ kind: "user", id, text: "hi", turn });
const thought = (id: string, turn: number): ChatItem => ({ kind: "thought", id, text: "…", turn });
const answer = (id: string, turn: number): ChatItem => ({
  kind: "assistant",
  id,
  text: "ok",
  turn,
});
const notice = (id: string, turn: number): ChatItem => ({
  kind: "notice",
  id,
  level: "warning",
  text: "Stopped.",
  turn,
});
const tool = (
  id: string,
  turn: number,
  status: ToolStatus = "completed",
  title = "read: a.ts",
  toolKind = "read",
): ToolEntry => ({
  kind: "tool",
  id,
  title,
  toolKind,
  status,
  turn,
});

describe("buildRows", () => {
  it("puts consecutive tool calls of one turn in one card, keyed by the first call", () => {
    const rows = buildRows([
      user("u1", 1),
      tool("t1", 1),
      tool("t2", 1),
      tool("t3", 1),
      answer("a1", 1),
    ]);
    expect(rows.map((r) => [r.kind, r.key])).toEqual([
      ["item", "u1"],
      ["tools", "t1"],
      ["item", "a1"],
    ]);
    const card = rows[1];
    expect(card?.kind === "tools" && card.tools.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("keeps the card key stable as calls join, so the card keeps its DOM", () => {
    const before = buildRows([tool("t1", 1)]);
    const after = buildRows([tool("t1", 1), tool("t2", 1)]);
    expect(before[0]?.key).toBe("t1");
    expect(after[0]?.key).toBe("t1");
  });

  it("starts a new card after text in between, and never merges across turns", () => {
    const rows = buildRows([tool("t1", 1), thought("th", 1), tool("t2", 1), tool("t3", 2)]);
    expect(rows.map((r) => r.key)).toEqual(["t1", "th", "t2", "t3"]);
  });

  it("labels only the first Hermes row of each turn; users and notices get no label", () => {
    const rows = buildRows([
      user("u1", 1),
      thought("th1", 1),
      tool("t1", 1),
      answer("a1", 1),
      user("u2", 2),
      notice("n2", 2),
      answer("a2", 2),
    ]);
    expect(rows.filter((r) => r.kind !== "end" && r.head).map((r) => r.key)).toEqual(["th1", "a2"]);
  });

  it("lays out an empty transcript as no rows", () => {
    expect(buildRows([])).toEqual([]);
  });
});

describe("parseToolTitle", () => {
  it("splits Hermes' `verb: detail` titles and capitalises the verb", () => {
    expect(parseToolTitle("read: src/auth/login.ts")).toEqual({
      label: "Read",
      detail: "src/auth/login.ts",
    });
    expect(parseToolTitle('terminal: npm test -- --grep "a: b"')).toEqual({
      label: "Terminal",
      detail: 'npm test -- --grep "a: b"',
    });
  });

  it("leaves a title without a verb prefix whole", () => {
    expect(parseToolTitle("Update the plan")).toEqual({ label: "", detail: "Update the plan" });
    // A drive letter is not a verb.
    expect(parseToolTitle("C:\\repo\\a.ts")).toEqual({ label: "", detail: "C:\\repo\\a.ts" });
  });
});

describe("tool counts", () => {
  it("counts by status and leaves zero counts out of the summary", () => {
    const c = countTools([
      tool("a", 1),
      tool("b", 1),
      tool("c", 1, "running"),
      tool("d", 1, "failed"),
    ]);
    expect(c).toEqual({ completed: 2, running: 1, failed: 1 });
    expect(describeCounts(c)).toBe("2 done, 1 failed, 1 running");
    expect(describeCounts(countTools([tool("a", 1)]))).toBe("1 done");
  });
});

describe("currentActivity", () => {
  it("is undefined when idle", () => {
    expect(currentActivity([tool("t", 1, "running")], false, 1)).toBeUndefined();
  });

  it("names the running call with a verb for its kind", () => {
    const items = [user("u", 1), tool("t", 1, "running", "terminal: npm test", "execute")];
    expect(currentActivity(items, true, 1)).toBe("Running npm test");
  });

  it("prefers the newest item: streaming text beats a call whose end never arrived", () => {
    const items = [tool("t", 1, "running"), answer("a", 1)];
    expect(currentActivity(items, true, 1)).toBe("Writing");
    expect(currentActivity([thought("th", 1)], true, 1)).toBe("Thinking");
  });

  it("finds an earlier call still running when the newest one finished", () => {
    const items = [
      tool("t1", 1, "running", "search: returnTo", "search"),
      tool("t2", 1, "completed"),
    ];
    expect(currentActivity(items, true, 1)).toBe("Searching returnTo");
  });

  it("ignores items of earlier turns", () => {
    const items = [tool("t1", 1, "running"), user("u2", 2)];
    expect(currentActivity(items, true, 2)).toBe("Working");
  });
});

describe("formatElapsed", () => {
  it("shows seconds, then minutes and seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(7.9)).toBe("7s");
    expect(formatElapsed(75)).toBe("1m 15s");
    expect(formatElapsed(-3)).toBe("0s");
  });
});

describe("usagePercent", () => {
  it("rounds, clamps, and shows a sliver as <1% rather than 0%", () => {
    expect(usagePercent({ used: 16_600, size: 1_000_000 })).toEqual({ ratio: 0.0166, label: "2%" });
    expect(usagePercent({ used: 3_000, size: 1_000_000 })?.label).toBe("<1%");
    expect(usagePercent({ used: 0, size: 1_000_000 })?.label).toBe("0%");
    expect(usagePercent({ used: 2_000_000, size: 1_000_000 })).toEqual({ ratio: 1, label: "100%" });
  });

  it("is undefined for a window of unknown size", () => {
    expect(usagePercent({ used: 10, size: 0 })).toBeUndefined();
  });
});
