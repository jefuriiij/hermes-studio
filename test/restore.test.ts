import { describe, expect, it } from "vitest";

import { applyOps, type ChatOp, emptyModel } from "../src/shared/chat";
import { stoppedPromptTexts } from "../src/webview/lib/restore";

const user = (notSent?: boolean) => ({
  kind: "user" as const,
  id: "u1",
  text: "my long prompt",
  turn: 1,
  ...(notSent ? { notSent } : {}),
});

describe("stoppedPromptTexts — which prompts return to the composer", () => {
  it("restores when a sent bubble flips to notSent in a later batch", () => {
    const before = applyOps(emptyModel(), [{ op: "add", item: user() }]);
    expect(stoppedPromptTexts(before, [{ op: "replace", item: user(true) }])).toEqual([
      "my long prompt",
    ]);
  });

  // Code review regression: a send that fails at once puts the add and the
  // notSent replace in ONE batch; the item is only known from the earlier op.
  it("restores when the add and the notSent replace arrive in the same batch", () => {
    const ops: ChatOp[] = [
      { op: "add", item: user() },
      { op: "replace", item: user(true) },
    ];
    expect(stoppedPromptTexts(emptyModel(), ops)).toEqual(["my long prompt"]);
  });

  it("never restores twice, or for a bubble that was already notSent", () => {
    const before = applyOps(emptyModel(), [{ op: "add", item: user(true) }]);
    expect(stoppedPromptTexts(before, [{ op: "replace", item: user(true) }])).toEqual([]);
    const twice: ChatOp[] = [
      { op: "add", item: user() },
      { op: "replace", item: user(true) },
      { op: "replace", item: user(true) },
    ];
    expect(stoppedPromptTexts(emptyModel(), twice)).toHaveLength(1);
  });

  it("forgets items across a clear", () => {
    const before = applyOps(emptyModel(), [{ op: "add", item: user() }]);
    expect(
      stoppedPromptTexts(before, [{ op: "clear" }, { op: "replace", item: user(true) }]),
    ).toEqual([]);
  });
});
