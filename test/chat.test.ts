import { describe, expect, it } from "vitest";

import { applyOps, type ChatOp, coalesceOps, emptyModel } from "../src/shared/chat";

const user = (id: string, text: string) => ({ kind: "user" as const, id, text, turn: 1 });
const asst = (id: string, text: string) => ({ kind: "assistant" as const, id, text, turn: 1 });

describe("applyOps", () => {
  it("adds, appends and replaces by id without mutating the input", () => {
    const m0 = emptyModel();
    const m1 = applyOps(m0, [
      { op: "add", item: user("u1", "hi") },
      { op: "add", item: asst("m1", "Hel") },
      { op: "append", id: "m1", text: "lo" },
    ]);
    expect(m0.items).toEqual([]);
    expect(m1.items.map((i) => ("text" in i ? i.text : ""))).toEqual(["hi", "Hello"]);

    const m2 = applyOps(m1, [{ op: "replace", item: asst("m1", "Rewritten") }]);
    expect(m1.items[1]).toMatchObject({ text: "Hello" });
    expect(m2.items[1]).toMatchObject({ text: "Rewritten" });
  });

  // A late or duplicated Hermes event must never throw or corrupt the chat.
  it("ignores ops for unknown ids and duplicate adds", () => {
    const m = applyOps(emptyModel(), [
      { op: "add", item: asst("m1", "a") },
      { op: "add", item: asst("m1", "dup") },
      { op: "append", id: "nope", text: "x" },
      { op: "replace", item: asst("nope", "x") },
    ]);
    expect(m.items).toEqual([asst("m1", "a")]);
  });

  it("does not append text to a tool row", () => {
    const tool = {
      kind: "tool" as const,
      id: "tc-1",
      title: "read: a.ts",
      status: "running" as const,
      turn: 1,
    };
    const m = applyOps(emptyModel(), [
      { op: "add", item: tool },
      { op: "append", id: "tc-1", text: "x" },
    ]);
    expect(m.items[0]).toEqual(tool);
  });

  it("clears items but keeps meta, and adds work after a clear", () => {
    const m = applyOps(emptyModel(), [
      { op: "add", item: user("u1", "old") },
      { op: "meta", patch: { title: "Kept" } },
      { op: "clear" },
      { op: "add", item: user("u2", "new") },
    ]);
    expect(m.items).toEqual([user("u2", "new")]);
    expect(m.meta.title).toBe("Kept");
  });

  it("returns the same object when nothing changed", () => {
    const m = emptyModel();
    expect(applyOps(m, [])).toBe(m);
    expect(applyOps(m, [{ op: "append", id: "nope", text: "x" }])).toBe(m);
  });
});

describe("coalesceOps", () => {
  it("merges consecutive appends to the same id and consecutive meta patches", () => {
    const ops: ChatOp[] = [
      { op: "append", id: "m1", text: "a" },
      { op: "append", id: "m1", text: "b" },
      { op: "append", id: "m2", text: "c" },
      { op: "meta", patch: { busy: true } },
      { op: "meta", patch: { title: "T" } },
    ];
    expect(coalesceOps(ops)).toEqual([
      { op: "append", id: "m1", text: "ab" },
      { op: "append", id: "m2", text: "c" },
      { op: "meta", patch: { busy: true, title: "T" } },
    ]);
  });

  // The property the whole design rests on: batching must not change the result.
  it("gives the same model as applying the ops one by one", () => {
    const ops: ChatOp[] = [
      { op: "add", item: asst("m1", "") },
      ...Array.from({ length: 50 }, (_, i) => ({
        op: "append" as const,
        id: "m1",
        text: String(i % 10),
      })),
      { op: "meta", patch: { busy: false } },
    ];
    const oneByOne = ops.reduce((m, o) => applyOps(m, [o]), emptyModel());
    expect(applyOps(emptyModel(), coalesceOps(ops))).toEqual(oneByOne);
  });
});

describe("clearing meta across the webview bridge (code review regression)", () => {
  // VS Code's postMessage is JSON: a key set to undefined vanishes, so clears
  // must be null — applyOps removes the field.
  it("null removes a field, and survives a JSON round trip", () => {
    const withTitle = applyOps(emptyModel(), [
      { op: "meta", patch: { title: "Old", usage: { used: 1, size: 2 } } },
    ]);
    const ops: ChatOp[] = [{ op: "meta", patch: { title: null, usage: null } }];
    const host = applyOps(withTitle, ops);
    const webview = applyOps(withTitle, JSON.parse(JSON.stringify(ops)) as ChatOp[]);
    expect(host.meta.title).toBeUndefined();
    expect(webview.meta).toEqual(host.meta);
    expect("title" in host.meta).toBe(false);
  });
});
