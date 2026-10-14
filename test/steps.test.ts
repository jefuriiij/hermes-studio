import { describe, expect, it } from "vitest";

import { applyOps, type ChatItem, type ChatModel, emptyModel } from "../src/shared/chat";
import { reduceUpdate } from "../src/logic/reducer";
import { currentActivity, waitingForApproval } from "../src/webview/lib/rows";

const ctx = { turn: 1, newId: (p: string) => `${p}1` };
const step = (m: ChatModel) =>
  m.items.find((i) => i.kind === "tool") as Extract<ChatItem, { kind: "tool" }>;
const run = (m: ChatModel, update: unknown) => applyOps(m, reduceUpdate(m, update, ctx));
const text = (t: string) => ({ type: "content", content: { type: "text", text: t } });

// Shapes as Hermes 0.21.5 sends them (acp_adapter/tools.py).
const start = {
  sessionUpdate: "tool_call",
  toolCallId: "call_1",
  title: "terminal: npm test",
  kind: "execute",
  content: [text("$ npm test")],
  locations: [{ path: "package.json" }],
};

describe("tool step details", () => {
  it("keeps what the step shows: its text and the files it touches", () => {
    const m = run(emptyModel(), start);
    expect(step(m)).toMatchObject({
      status: "running",
      output: "$ npm test",
      locations: [{ path: "package.json" }],
    });
  });

  it("an update's content REPLACES the earlier content (ACP)", () => {
    let m = run(emptyModel(), start);
    m = run(m, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: [text("12 passing\n1 failing")],
    });
    expect(step(m)).toMatchObject({ status: "completed", output: "12 passing\n1 failing" });
    // Locations were not in the update: they stay.
    expect(step(m).locations).toEqual([{ path: "package.json" }]);
  });

  it("an empty content list clears the output; no content leaves it", () => {
    let m = run(emptyModel(), start);
    m = run(m, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" });
    expect(step(m).output).toBe("$ npm test");
    m = run(m, { sessionUpdate: "tool_call_update", toolCallId: "call_1", content: [] });
    expect(step(m).output).toBeUndefined();
    expect("output" in step(m)).toBe(false); // deleted, not undefined (JSON bridge)
  });

  it("turns a diff block into a folded diff view", () => {
    const m = run(emptyModel(), {
      sessionUpdate: "tool_call",
      toolCallId: "call_2",
      title: "patch: src/a.ts",
      kind: "edit",
      content: [{ type: "diff", path: "src/a.ts", oldText: "a = 1\n", newText: "a = 2\n" }],
    });
    expect(step(m).diff).toMatchObject({ path: "src/a.ts", added: 1, removed: 1 });
  });

  it("caps a huge output and makes hidden characters visible", () => {
    const m = run(emptyModel(), { ...start, content: [text(`${"x".repeat(10_000)}‮`)] });
    const out = step(m).output ?? "";
    expect(out.length).toBeLessThan(4100);
    expect(out).toMatch(/more characters\)$/);
    const m2 = run(emptyModel(), { ...start, content: [text("ok‮ko")] });
    expect(step(m2).output).toBe("ok\\u{202E}ko");
  });

  it("keeps at most 5 distinct locations, with valid line numbers only", () => {
    const m = run(emptyModel(), {
      ...start,
      locations: [
        { path: "a.ts", line: 3 },
        { path: "a.ts", line: 9 },
        { path: "b.ts", line: -1 },
        { path: "c.ts" },
        { path: "d.ts" },
        { path: "e.ts" },
        { path: "f.ts" },
        { nope: true },
      ],
    });
    expect(step(m).locations).toEqual([
      { path: "a.ts", line: 3 },
      { path: "b.ts" },
      { path: "c.ts" },
      { path: "d.ts" },
      { path: "e.ts" },
    ]);
  });
});

describe("waiting for an approval", () => {
  const card = (state: "pending" | "answered"): ChatItem => ({
    kind: "permission",
    id: "perm~1",
    turn: 1,
    action: "edit",
    heading: "Edit",
    options: [],
    state,
  });

  it("is what Hermes is doing while a card is pending", () => {
    const items: ChatItem[] = [
      { kind: "tool", id: "tool:x", title: "patch: a.ts", status: "running", turn: 1 },
      card("pending"),
    ];
    expect(waitingForApproval(items)).toBe(true);
    expect(currentActivity(items, true, 1)).toBe("Waiting for your approval");
    expect(waitingForApproval([card("answered")])).toBe(false);
  });
});
