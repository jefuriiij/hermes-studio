// Notifications (mock board 16): when, what they say, and the Windows toast.

import { describe, expect, it } from "vitest";

import {
  type Attention,
  channels,
  limitReason,
  stopWhy,
  tookText,
  vscodeMessage,
  windowsMessage,
} from "../src/logic/notify";
import { encodeCommand, TOAST_SCRIPT, toastTag, toastXml, xmlEscape } from "../src/logic/winToast";
import { isRunning, withBackground } from "../src/webview/lib/sessions";

const approval: Attention = {
  kind: "approval",
  sessionId: "s1",
  cardId: "perm~1",
  title: "Fix the login redirect after OAuth",
  what: "Edit: src/auth/oauth.ts",
  background: false,
};
const done: Attention = {
  kind: "done",
  sessionId: "s1",
  title: "Fix it",
  ms: 134_000,
  background: false,
};
const on = { enabled: true, windows: true };

describe("when to tell you", () => {
  it("never while you look at that chat", () => {
    expect(channels(done, { chatVisible: true, windowFocused: true }, on)).toEqual({
      vscode: false,
      windows: false,
      unseen: false,
    });
  });

  it("the chat is not on screen: VS Code's notification", () => {
    expect(channels(done, { chatVisible: false, windowFocused: true }, on)).toEqual({
      vscode: true,
      windows: false,
      unseen: true,
    });
  });

  it("VS Code is in the back: Windows's, and VS Code's only if the chat is hidden too", () => {
    expect(channels(done, { chatVisible: true, windowFocused: false }, on)).toMatchObject({
      vscode: false,
      windows: true,
    });
    expect(channels(done, { chatVisible: false, windowFocused: false }, on)).toMatchObject({
      vscode: true,
      windows: true,
    });
  });

  it("a chat in the background is never the one you look at", () => {
    const bg = { ...done, background: true };
    expect(channels(bg, { chatVisible: true, windowFocused: true }, on)).toMatchObject({
      vscode: true,
      windows: false,
      unseen: true,
    });
  });

  it("an approval counts as waiting (the controller knows), not as unseen", () => {
    expect(channels(approval, { chatVisible: false, windowFocused: false }, on).unseen).toBe(false);
  });

  it("the settings turn them off; the count stays", () => {
    const look = { chatVisible: false, windowFocused: false };
    expect(channels(done, look, { enabled: false, windows: true })).toEqual({
      vscode: false,
      windows: false,
      unseen: true,
    });
    expect(channels(done, look, { enabled: true, windows: false })).toMatchObject({
      vscode: true,
      windows: false,
    });
  });
});

describe("what they say", () => {
  it("how long it took", () => {
    expect(tookText(42_400)).toBe("took 42 s");
    expect(tookText(134_000)).toBe("took 2 min 14 s");
    expect(tookText(120_000)).toBe("took 2 min");
    expect(tookText(3_900_000)).toBe("took 1 h 5 min");
  });

  it("why a turn did not finish the job", () => {
    expect(stopWhy("end_turn", undefined)).toBeUndefined();
    expect(stopWhy("end_turn", { kind: "limit", provider: "Claude", resets: "14:00" })).toBe(
      "Claude usage limit — resets at 14:00",
    );
    expect(limitReason({ kind: "overloaded", resets: "in 5 min" })).toBe(
      "The provider is overloaded — resets in 5 min",
    );
    expect(stopWhy("max_tokens", undefined)).toBe("Hermes stopped early (max tokens)");
    expect(stopWhy("refusal", undefined)).toBe("Hermes no longer has this session");
  });

  it("VS Code's words (as before for approvals)", () => {
    expect(vscodeMessage(approval)).toEqual({
      level: "warning",
      text: "Hermes is waiting for your approval — Edit: src/auth/oauth.ts",
      action: "Show",
    });
    expect(vscodeMessage({ ...approval, background: true }).text).toBe(
      "Hermes needs your OK in “Fix the login redirect after OAuth”: Edit: src/auth/oauth.ts",
    );
    expect(vscodeMessage(done)).toEqual({
      level: "info",
      text: "Hermes finished “Fix it”.",
      action: "Open",
    });
  });

  it("Windows's words", () => {
    expect(windowsMessage(approval)).toEqual({
      title: "Hermes needs your OK",
      body: "Edit: src/auth/oauth.ts",
      attribution: "in “Fix the login redirect after OAuth”",
      action: "Show",
    });
    expect(windowsMessage(done)).toMatchObject({
      title: "Hermes finished",
      attribution: "took 2 min 14 s",
    });
    expect(
      windowsMessage({ ...done, kind: "stopped", why: "Claude usage limit — resets at 14:00" }),
    ).toMatchObject({ title: "Hermes stopped", body: "Claude usage limit — resets at 14:00" });
  });
});

describe("the Windows toast", () => {
  // A session title comes from the model: it must stay text.
  it("escapes every value, and drops what XML cannot carry", () => {
    expect(xmlEscape(`<b a="1">&'x'</b>`)).toBe(
      "&lt;b a=&quot;1&quot;&gt;&amp;&apos;x&apos;&lt;/b&gt;",
    );
    expect(xmlEscape(`a${String.fromCharCode(0, 7, 0xfffe)}b`)).toBe("ab");
    const xml = toastXml({
      title: "Hermes finished",
      body: `“</text><text>injected”`,
      action: "Open",
      launch: "vscode://jefuriiij.hermes-studio/show?session=s1&card=c2",
    });
    expect(xml).not.toContain("<text>injected");
    expect(xml).toContain('launch="vscode://jefuriiij.hermes-studio/show?session=s1&amp;card=c2"');
    expect(xml).toContain('activationType="protocol"');
  });

  // Text never becomes PowerShell: it only travels in environment variables.
  it("runs one constant script that reads the toast from the environment", () => {
    expect(TOAST_SCRIPT).toContain("$doc.LoadXml($env:HS_TOAST_XML)");
    expect(TOAST_SCRIPT).not.toMatch(/Invoke-Expression|iex /i);
    expect(Buffer.from(encodeCommand(TOAST_SCRIPT), "base64").toString("utf16le")).toBe(
      TOAST_SCRIPT,
    );
  });

  it("one toast per chat and kind (a newer one replaces it)", () => {
    expect(toastTag("done", "3f2a-9c")).toBe("done-3f2a-9c");
    expect(toastTag("approval", "x".repeat(100))).toHaveLength(64);
    expect(toastTag("done", "a/b c")).toBe("done-abc");
  });
});

describe("the Sessions pop-up", () => {
  it("lists what needs you first, then what works, then what ended while you were away", () => {
    const rows = withBackground(
      [{ id: "old", title: "Old chat" }],
      [
        { id: "d", title: "Done", state: "done" },
        { id: "w", title: "Working", state: "working" },
        { id: "q", title: "Needs you", state: "waiting" },
      ],
    );
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["q", "waiting"],
      ["w", "working"],
      ["d", "done"],
      ["old", undefined],
    ]);
    expect([
      isRunning("working"),
      isRunning("waiting"),
      isRunning("done"),
      isRunning(undefined),
    ]).toEqual([true, true, false, false]);
  });
});
