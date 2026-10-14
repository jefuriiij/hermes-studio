import { describe, expect, it } from "vitest";

import { SessionListService } from "../src/host/sessionList";
import { isWebviewToHost, type SessionList, type SessionSummary } from "../src/shared/protocol";
import {
  filterSessions,
  groupSessions,
  parseTime,
  relativeTime,
  shortAgo,
  withBackground,
} from "../src/webview/lib/sessions";

// Local-time constructors keep these independent of the machine's time zone.
const NOW = new Date(2026, 8, 27, 15, 30).getTime();
const at = (daysAgo: number, h: number, m = 0) => {
  const d = new Date(2026, 8, 27 - daysAgo, h, m);
  return d.getTime();
};
const iso = (t: number) => new Date(t).toISOString();
const s = (id: string, t: number | undefined, title?: string): SessionSummary => ({
  id,
  ...(title ? { title } : {}),
  ...(t === undefined ? {} : { updatedAt: iso(t) }),
});

describe("parseTime", () => {
  it("reads Hermes's ISO timestamps, and tolerates epoch seconds or ms", () => {
    expect(parseTime("2026-09-20T11:17:17.940042+00:00")).toBe(
      Date.UTC(2026, 8, 20, 11, 17, 17, 940),
    );
    expect(parseTime("1790478123")).toBe(1_790_478_123_000);
    expect(parseTime("1790478123456")).toBe(1_790_478_123_456);
    expect(parseTime("")).toBeUndefined();
    expect(parseTime("not a date")).toBeUndefined();
    expect(parseTime(undefined)).toBeUndefined();
  });
});

describe("shortAgo (the sessions pop-up)", () => {
  it("says now, minutes, hours today, days this week, then the date", () => {
    expect(shortAgo(NOW - 20_000, NOW)).toBe("now");
    expect(shortAgo(NOW - 12 * 60_000, NOW)).toBe("12m");
    expect(shortAgo(at(0, 12, 10), NOW)).toBe("3h");
    expect(shortAgo(at(1, 23, 50), NOW)).toBe("1d"); // yesterday, even 16 h ago
    expect(shortAgo(at(4, 9), NOW)).toBe("4d");
    expect(shortAgo(at(12, 9), NOW, "en-US")).toBe("Sep 15");
    expect(shortAgo(new Date(2025, 8, 3).getTime(), NOW, "en-US")).toBe("Sep 3, 2025");
    expect(shortAgo(undefined, NOW)).toBe("");
    expect(shortAgo(NOW + 5000, NOW)).toBe("now"); // a clock a little ahead
  });
});

describe("relativeTime", () => {
  it("counts minutes within the hour, then shows the clock, then the day", () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe("Just now");
    expect(relativeTime(NOW - 12 * 60_000, NOW)).toBe("12 min ago");
    expect(relativeTime(at(0, 9, 14), NOW, "en-GB")).toBe("09:14");
    expect(relativeTime(at(1, 23, 59), NOW)).toBe("Yesterday");
    expect(relativeTime(at(3, 10), NOW, "en-GB")).toBe("Thu");
    expect(relativeTime(at(20, 10), NOW, "en-GB")).toBe("7 Sept");
    expect(relativeTime(new Date(2025, 2, 3).getTime(), NOW, "en-GB")).toBe("3 Mar 2025");
    expect(relativeTime(undefined, NOW)).toBe("");
  });

  it("does not call a time from late yesterday 'min ago' just after midnight", () => {
    const justAfterMidnight = new Date(2026, 8, 27, 0, 10).getTime();
    expect(relativeTime(at(1, 23, 50), justAfterMidnight)).toBe("Yesterday");
  });
});

describe("groupSessions", () => {
  it("groups by calendar day and keeps Hermes's order inside each group", () => {
    const groups = groupSessions(
      [
        s("a", at(0, 15)),
        s("b", at(0, 9)),
        s("c", at(1, 20)),
        s("d", at(4, 10)),
        s("e", at(9, 10)),
        s("f", undefined),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["This week", ["d"]],
      ["Older", ["e", "f"]],
    ]);
  });

  it("leaves empty groups out", () => {
    expect(groupSessions([s("a", at(8, 1))], NOW).map((g) => g.label)).toEqual(["Older"]);
    expect(groupSessions([], NOW)).toEqual([]);
  });
});

describe("filterSessions", () => {
  const list = [
    s("1", NOW, "Fix the login redirect"),
    s("2", NOW, "Café menu import"),
    s("3", NOW),
  ];

  it("matches every word, ignoring case and accents", () => {
    expect(filterSessions(list, "LOGIN fix").map((x) => x.id)).toEqual(["1"]);
    expect(filterSessions(list, "cafe").map((x) => x.id)).toEqual(["2"]);
    expect(filterSessions(list, "redirect menu")).toEqual([]);
  });

  it("returns everything for an empty query", () => {
    expect(filterSessions(list, "   ").map((x) => x.id)).toEqual(["1", "2", "3"]);
  });
});

describe("SessionListService", () => {
  const page = (ids: string[], nextCursor?: string) => ({
    items: ids.map((id) => ({ id })),
    ...(nextCursor ? { nextCursor } : {}),
  });

  it("publishes loading, then the page; a cursor appends without duplicates", async () => {
    const published: SessionList[] = [];
    const pages: Record<string, ReturnType<typeof page>> = {
      first: page(["a", "b"], "b"),
      b: page(["b", "c"]),
    };
    const svc = new SessionListService(
      async (cursor) => pages[cursor ?? "first"] as ReturnType<typeof page>,
      (l) => published.push(l),
    );
    await svc.request();
    expect(published.map((l) => l.loading)).toEqual([true, false]);
    expect(svc.current).toEqual({
      items: [{ id: "a" }, { id: "b" }],
      nextCursor: "b",
      loading: false,
    });
    await svc.request("b");
    expect(svc.current).toEqual({ items: [{ id: "a" }, { id: "b" }, { id: "c" }], loading: false });
  });

  it("keeps what is shown and reports the error when a page fails", async () => {
    let fail = false;
    const svc = new SessionListService(
      async () => {
        if (fail) throw new Error("Hermes is not running");
        return page(["a"]);
      },
      () => undefined,
    );
    await svc.request();
    fail = true;
    await svc.request();
    expect(svc.current).toEqual({
      items: [{ id: "a" }],
      loading: false,
      error: "Hermes is not running",
    });
  });

  it("lets only the newest request publish its result", async () => {
    const resolvers: ((p: ReturnType<typeof page>) => void)[] = [];
    const published: SessionList[] = [];
    const svc = new SessionListService(
      () => new Promise((r) => resolvers.push(r)),
      (l) => published.push(l),
    );
    const older = svc.request();
    const newer = svc.request();
    resolvers[1]?.(page(["new"]));
    await newer;
    resolvers[0]?.(page(["old"]));
    await older;
    expect(svc.current.items).toEqual([{ id: "new" }]);
    expect(published.at(-1)?.items).toEqual([{ id: "new" }]);
  });

  it("never publishes undefined values (they vanish crossing postMessage)", async () => {
    const published: SessionList[] = [];
    const svc = new SessionListService(
      async () => page(["a"]),
      (l) => published.push(l),
    );
    await svc.request();
    for (const l of published) {
      for (const v of Object.values(l)) expect(v).not.toBeUndefined();
    }
  });
});

describe("isWebviewToHost: session messages", () => {
  it("accepts listSessions with or without a cursor, and openSession with an id", () => {
    expect(isWebviewToHost({ type: "listSessions" })).toBe(true);
    expect(isWebviewToHost({ type: "listSessions", cursor: "0b6f3a52" })).toBe(true);
    expect(isWebviewToHost({ type: "openSession", sessionId: "0b6f3a52" })).toBe(true);
  });

  it("rejects missing, empty, non-string or oversized ids", () => {
    expect(isWebviewToHost({ type: "openSession" })).toBe(false);
    expect(isWebviewToHost({ type: "openSession", sessionId: "" })).toBe(false);
    expect(isWebviewToHost({ type: "openSession", sessionId: 42 })).toBe(false);
    expect(isWebviewToHost({ type: "openSession", sessionId: "x".repeat(257) })).toBe(false);
    expect(isWebviewToHost({ type: "listSessions", cursor: 5 })).toBe(false);
  });
});

describe("chats working in the background, in the pop-up", () => {
  const listed: SessionSummary[] = [
    { id: "a", title: "Older chat", updatedAt: "2026-09-20T10:00:00Z" },
    { id: "b", title: "Test message", updatedAt: "2026-09-27T10:00:00Z" },
  ];

  it("puts them on top, waiting first, marked; Hermes's title wins when it has one", () => {
    const rows = withBackground(listed, [
      { id: "b", title: "test", state: "working" },
      { id: "new", title: "first message", state: "waiting" },
    ]);
    expect(rows.map((r) => [r.id, r.title, r.state])).toEqual([
      ["new", "first message", "waiting"],
      ["b", "Test message", "working"],
      ["a", "Older chat", undefined],
    ]);
    // A listed one keeps its time.
    expect(rows[1]?.updatedAt).toBe("2026-09-27T10:00:00Z");
  });

  it("is just Hermes's list when nothing works in the background", () => {
    expect(withBackground(listed, [])).toEqual(listed);
  });
});
