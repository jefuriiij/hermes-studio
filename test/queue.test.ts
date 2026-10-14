// Messages typed while Hermes works (mock board 17): the pure rules.

import { describe, expect, it } from "vitest";

import type { Attachment } from "../src/logic/attachments";
import { absorbedReply, canSendNow } from "../src/logic/queue";
import { isWebviewToHost } from "../src/shared/protocol";
import { composerPlaceholder } from "../src/webview/lib/format";
import { emptyModel } from "../src/shared/chat";

describe("Hermes's answer to a message sent into a running reply", () => {
  it("knows both answers (acp_adapter/server.py _claim_turn_or_queue)", () => {
    expect(absorbedReply("Redirected the active turn with your correction.")).toBe("redirected");
    expect(absorbedReply("Queued for the next turn. (2 queued)")).toBe("queued");
  });

  it("anything else is reply text", () => {
    expect(absorbedReply("Redirected the active turn")).toBeUndefined();
    expect(absorbedReply("Queued for the next turn. (two queued)")).toBeUndefined();
    expect(absorbedReply("Sure — here is the summary.")).toBeUndefined();
  });
});

describe("what may go into a running reply", () => {
  const text: Attachment = {
    id: "s",
    kind: "selection",
    label: "a.ts 1–2",
    block: { type: "text", text: "x" },
  };
  const file: Attachment = {
    id: "f",
    kind: "file",
    label: "a.ts",
    block: { type: "resource_link", uri: "file:///a.ts", name: "a.ts" },
  };

  it("text only: files and images wait for the reply to end", () => {
    expect(canSendNow([])).toBe(true);
    expect(canSendNow([text])).toBe(true);
    expect(canSendNow([text, file])).toBe(false);
  });
});

describe("the composer while Hermes works", () => {
  it("says that Enter queues", () => {
    const m = emptyModel().meta;
    expect(composerPlaceholder({ ...m, connection: { state: "ready" }, busy: true })).toBe(
      "Hermes is working — Enter queues your message",
    );
    expect(composerPlaceholder({ ...m, connection: { state: "ready" }, busy: false })).toMatch(
      /^Ask Hermes/,
    );
  });

  it("checks the queue's messages", () => {
    expect(isWebviewToHost({ type: "queueSendNow", id: "queued~1" })).toBe(true);
    expect(isWebviewToHost({ type: "queueSendNow" })).toBe(false);
    expect(isWebviewToHost({ type: "queueRemove", id: "queued~1", restore: true })).toBe(true);
    expect(isWebviewToHost({ type: "queueRemove", id: "queued~1", restore: "yes" })).toBe(false);
  });
});
