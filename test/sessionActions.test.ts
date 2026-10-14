import { describe, expect, it } from "vitest";

import type { RunResult } from "../src/host/accountUsage";
import { SessionActions, type SessionOwner } from "../src/host/sessionActions";
import {
  cleanTitle,
  deleteArgs,
  failureText,
  MAX_TITLE,
  renameArgs,
} from "../src/logic/sessionActions";
import { isWebviewToHost, type SessionActionResult } from "../src/shared/protocol";

describe("cleanTitle", () => {
  it("collapses whitespace and trims, as Hermes stores it", () => {
    expect(cleanTitle("  Roster   page\tloads twice ")).toEqual({
      ok: true,
      title: "Roster page loads twice",
    });
  });

  it("drops control, zero-width and bidi characters", () => {
    const sneaky = `a${String.fromCharCode(0x200b)}b${String.fromCharCode(0x202e)}c${String.fromCharCode(7)}`;
    expect(cleanTitle(sneaky)).toEqual({ ok: true, title: "a b c" });
  });

  it("refuses an empty name and one past Hermes's 100 characters", () => {
    expect(cleanTitle("   ")).toMatchObject({ ok: false });
    expect(cleanTitle("x".repeat(MAX_TITLE))).toMatchObject({ ok: true });
    const long = cleanTitle("x".repeat(MAX_TITLE + 1));
    expect(long).toMatchObject({ ok: false });
    expect(long.ok === false && long.error).toMatch(/at most 100/);
  });
});

describe("the Hermes commands", () => {
  it("end the options with --, so a name or id is never read as a flag", () => {
    expect(renameArgs("abc-123", "-v is fine")).toEqual([
      "sessions",
      "rename",
      "--",
      "abc-123",
      "-v is fine",
    ]);
    expect(deleteArgs("abc-123")).toEqual(["sessions", "delete", "--yes", "--", "abc-123"]);
  });

  it("turns Hermes's refusals into plain words", () => {
    expect(failureText("Error: Title 'Fix it' is already in use by session 20260927_x", "")).toBe(
      "Another session already has that name.",
    );
    expect(failureText("Session 'abc' not found.", "")).toBe("Hermes no longer has that session.");
    expect(failureText("", "Error: something odd\nmore")).toBe("something odd");
    expect(failureText("", "")).toMatch(/See the log/);
  });
});

describe("SessionActions", () => {
  function rig(opts: { blocked?: string; run?: RunResult } = {}) {
    const calls: string[] = [];
    const results: SessionActionResult[] = [];
    let refreshed = 0;
    const owner: SessionOwner = {
      sessionChangeBlocked: () => opts.blocked,
      leaveSession: async (id) => {
        calls.push(`leave ${id}`);
      },
      forgetSession: (id) => calls.push(`forget ${id}`),
      sessionRenamed: (id, title) => calls.push(`renamed ${id} ${title}`),
      sessionTitle: () => "Old name",
    };
    const svc = new SessionActions(
      owner,
      () => (args) => {
        calls.push(`run ${args.join(" ")}`);
        return Promise.resolve(opts.run ?? { code: 0, stdout: "ok", stderr: "" });
      },
      (r) => results.push(r),
      () => refreshed++,
      () => undefined,
    );
    return { svc, calls, results, refreshed: () => refreshed };
  }

  it("renames through Hermes, then updates the chat and the list", async () => {
    const r = rig();
    await r.svc.rename("s1", "  New   name ");
    expect(r.calls).toEqual(["run sessions rename -- s1 New name", "renamed s1 New name"]);
    expect(r.results).toEqual([
      { action: "rename", sessionId: "s1", ok: true, message: "Renamed." },
    ]);
    expect(r.refreshed()).toBe(1);
  });

  it("deletes: leaves the chat first, then forgets the session", async () => {
    const r = rig();
    await r.svc.delete("s1");
    expect(r.calls).toEqual(["leave s1", "run sessions delete --yes -- s1", "forget s1"]);
    expect(r.results[0]).toMatchObject({ ok: true, message: "Deleted “Old name”." });
  });

  it("says why when Hermes refuses, and forgets nothing", async () => {
    const r = rig({
      run: { code: 1, stdout: "Error: Title 'X' is already in use by session y", stderr: "" },
    });
    await r.svc.rename("s1", "X");
    expect(r.results[0]).toMatchObject({
      ok: false,
      message: "Another session already has that name.",
    });
    expect(r.calls.some((c) => c.startsWith("renamed"))).toBe(false);
  });

  it("runs nothing for a blocked session or a bad name", async () => {
    const blocked = rig({ blocked: "It is still working in the background." });
    await blocked.svc.delete("s1");
    expect(blocked.calls).toEqual([]);
    expect(blocked.results[0]).toMatchObject({
      ok: false,
      message: "It is still working in the background.",
    });

    const empty = rig();
    await empty.svc.rename("s1", "   ");
    expect(empty.calls).toEqual([]);
    expect(empty.results[0]).toMatchObject({ ok: false });
  });
});

describe("isWebviewToHost: rename / delete", () => {
  it("needs a session id, and a bounded title for a rename", () => {
    expect(isWebviewToHost({ type: "deleteSession", sessionId: "abc" })).toBe(true);
    expect(isWebviewToHost({ type: "deleteSession" })).toBe(false);
    expect(isWebviewToHost({ type: "renameSession", sessionId: "abc", title: "New" })).toBe(true);
    expect(isWebviewToHost({ type: "renameSession", sessionId: "abc" })).toBe(false);
    expect(
      isWebviewToHost({ type: "renameSession", sessionId: "abc", title: "x".repeat(1001) }),
    ).toBe(false);
  });
});
