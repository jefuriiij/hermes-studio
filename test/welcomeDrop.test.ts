import { describe, expect, it } from "vitest";

import type { PanelsView } from "../src/shared/panels";
import { isWebviewToHost } from "../src/shared/protocol";
import { uriList } from "../src/webview/lib/drop";
import { agoPhrase, learnedRow } from "../src/webview/lib/welcome";

const NOW = new Date(2026, 8, 28, 15, 0).getTime();
const H = 3_600_000;

function view(learning: Partial<PanelsView["learning"]>, lastRunAt?: number): PanelsView {
  return {
    found: true,
    home: "C:/h",
    learning: {
      newThisWeek: 0,
      improvedThisWeek: 0,
      learnedTotal: 0,
      skillsTotal: 0,
      unseen: 0,
      items: [],
      totalChanges: 0,
      ...learning,
    },
    curator: { state: "on", every: "weekly", ...(lastRunAt !== undefined ? { lastRunAt } : {}) },
  } as unknown as PanelsView;
}

const item = (skill: string, kind: "new" | "learned" | "improved", at: number) => ({
  skill,
  kind,
  lastChangeAt: at,
  changes: 1,
  history: "h",
});

describe("the empty chat's learned row", () => {
  it("says what changed since you last looked, newest first, with sparkles", () => {
    const row = learnedRow(
      view({
        unseen: 3,
        newThisWeek: 2,
        items: [item("oauth-redirect-guard", "new", NOW - 30_000), item("x", "new", NOW - 5 * H)],
      }),
      NOW,
    );
    expect(row).toEqual({
      kind: "fresh",
      title: "New skill learned",
      skill: "oauth-redirect-guard",
      when: "just now",
      more: 2,
    });
    const improved = learnedRow(
      view({ unseen: 1, items: [item("git-workflows", "improved", NOW - 2 * H)] }),
      NOW,
    );
    expect(improved).toMatchObject({ title: "Skill improved", when: "2 h ago", more: 0 });
  });

  it("quiet: the week's counts and when the curator ran", () => {
    expect(learnedRow(view({ newThisWeek: 2 }, NOW - 3 * H), NOW)).toEqual({
      kind: "week",
      text: "Hermes learned 2 skills this week",
      curator: "curator ran 3 h ago",
    });
    expect(learnedRow(view({ newThisWeek: 1, improvedThisWeek: 4 }), NOW)).toEqual({
      kind: "week",
      text: "Hermes learned 1 skill this week and improved 4",
    });
    expect(learnedRow(view({ improvedThisWeek: 1 }), NOW)).toMatchObject({
      text: "Hermes improved 1 skill this week",
    });
    expect(learnedRow(view({ learnedTotal: 12 }), NOW)).toMatchObject({
      text: "Hermes has learned 12 skills so far",
    });
  });

  it("shows nothing without Hermes's files or with nothing learned", () => {
    expect(learnedRow(null, NOW)).toBeUndefined();
    expect(learnedRow({ ...view({ newThisWeek: 3 }), found: false }, NOW)).toBeUndefined();
    expect(learnedRow(view({}), NOW)).toBeUndefined();
  });

  it("words the time plainly", () => {
    expect(agoPhrase(NOW - 20_000, NOW)).toBe("just now");
    expect(agoPhrase(NOW - 12 * 60_000, NOW)).toBe("12 min ago");
    expect(agoPhrase(NOW - 3 * H, NOW)).toBe("3 h ago");
    expect(agoPhrase(new Date(2026, 8, 27, 9, 0).getTime(), NOW)).toBe("yesterday");
    expect(agoPhrase(new Date(2026, 8, 24, 9, 0).getTime(), NOW)).toBe("4 days ago");
    expect(agoPhrase(new Date(2026, 8, 3, 9, 0).getTime(), NOW, "en-US")).toBe("on Sep 3");
  });
});

describe("dropping files", () => {
  it("reads VS Code's uri-list: one per line, # lines are comments", () => {
    expect(
      uriList(
        "# a comment\r\nfile:///c%3A/work/src/auth.ts\r\n\r\nfile:///c%3A/work/README.md\r\nnot a uri\r\n",
      ),
    ).toEqual(["file:///c%3A/work/src/auth.ts", "file:///c%3A/work/README.md"]);
    expect(uriList("")).toEqual([]);
  });

  it("the host takes at most 50 URIs, each bounded", () => {
    expect(isWebviewToHost({ type: "dropUris", uris: ["file:///a"] })).toBe(true);
    expect(isWebviewToHost({ type: "dropUris", uris: [] })).toBe(false);
    expect(isWebviewToHost({ type: "dropUris", uris: Array(51).fill("file:///a") })).toBe(false);
    expect(isWebviewToHost({ type: "dropUris", uris: [7] })).toBe(false);
  });
});
