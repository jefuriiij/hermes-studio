import { describe, expect, it } from "vitest";

import { applyOps, type ChatModel, emptyModel } from "../src/shared/chat";
import {
  closeTurnOps,
  isModelCommand,
  modelDisplayName,
  modelLabel,
  modelSwitchedTo,
  reduceUpdate,
} from "../src/logic/reducer";

// One counter for the whole file, like the controller's: generated ids must be
// unique across turns, or applyOps drops the duplicate add.
let idSeq = 0;

/** Feed raw updates through the reducer the way the controller does. */
function run(updates: unknown[], start: ChatModel = emptyModel(), turn = 1): ChatModel {
  const ctx = { turn, newId: (p: string) => `${p}${++idSeq}` };
  return updates.reduce<ChatModel>((m, u) => applyOps(m, reduceUpdate(m, u, ctx)), start);
}

const MID = "881f8473-e634-412f-82c5-3ef1b3ba9f32";
const chunk = (kind: string, text: string, messageId?: string) => ({
  sessionUpdate: kind,
  content: { type: "text", text },
  ...(messageId ? { messageId } : {}),
});

describe("reduceUpdate — the captured real Hermes turn", () => {
  // Captured from hermes.exe acp 0.21.5: 3 thought chunks then 5 message chunks,
  // ALL under one messageId, then usage, then the title after the turn ended.
  const wire = [
    {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "help", description: "x" }],
    },
    { sessionUpdate: "usage_update", used: 0, size: 128000 },
    {
      sessionUpdate: "session_info_update",
      title: "Reply with a short greeting; do not use tools.",
    },
    chunk("agent_thought_chunk", "Thinking about ", MID),
    chunk("agent_thought_chunk", "how to greet ", MID),
    chunk("agent_thought_chunk", "the user.", MID),
    chunk("agent_message_chunk", "# Hello\n\n", MID),
    chunk("agent_message_chunk", "Here is **bold** text and ", MID),
    chunk("agent_message_chunk", "a list:\n\n- one\n- two\n\n", MID),
    chunk("agent_message_chunk", "```ts\nconst x = 1;\n```\n\n", MID),
    chunk("agent_message_chunk", "<script>alert(1)</script> done.", MID),
    { sessionUpdate: "usage_update", used: 1137, size: 128000 },
    { sessionUpdate: "session_info_update", title: "# Hello" },
  ];

  it("keeps the thought and the answer as two items with unique ids", () => {
    const m = run(wire);
    expect(m.items.map((i) => [i.kind, i.id])).toEqual([
      ["thought", `thought:${MID}`],
      ["assistant", `msg:${MID}`],
    ]);
    expect(new Set(m.items.map((i) => i.id)).size).toBe(m.items.length);
  });

  it("accumulates the full text of each", () => {
    const m = run(wire);
    expect(m.items[0]).toMatchObject({
      text: "Thinking about how to greet the user.",
      messageId: MID,
    });
    expect(m.items[1]).toMatchObject({
      text: "# Hello\n\nHere is **bold** text and a list:\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n\n<script>alert(1)</script> done.",
    });
  });

  it("takes usage and the late title into meta", () => {
    const m = run(wire);
    expect(m.meta.usage).toEqual({ used: 1137, size: 128000 });
    expect(m.meta.title).toBe("# Hello");
  });
});

describe("reduceUpdate — tools", () => {
  it("treats a tool_call without status as running, then completes it", () => {
    const m = run([
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1a2b3c4d5e6f",
        title: "read: src/a.ts",
        kind: "read",
      },
    ]);
    expect(m.items[0]).toMatchObject({ kind: "tool", status: "running", toolKind: "read" });
    const done = run(
      [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1a2b3c4d5e6f",
          kind: "read",
          status: "completed",
        },
      ],
      m,
    );
    expect(done.items[0]).toMatchObject({ status: "completed", title: "read: src/a.ts" });
  });

  // Hermes sends these for permission bookkeeping ids it never announced.
  it("ignores a tool_call_update for an unknown (synthetic) id", () => {
    const m = run([
      { sessionUpdate: "tool_call_update", toolCallId: "perm-check-1", status: "completed" },
    ]);
    expect(m.items).toEqual([]);
  });

  it("closes running tools as failed at turn end", () => {
    const m = run([
      { sessionUpdate: "tool_call", toolCallId: "a", title: "run: npm test", kind: "execute" },
      {
        sessionUpdate: "tool_call",
        toolCallId: "b",
        title: "read: x",
        kind: "read",
        status: "completed",
      },
    ]);
    const closed = applyOps(m, closeTurnOps(m));
    expect(closed.items.map((i) => i.kind === "tool" && i.status)).toEqual(["failed", "completed"]);
  });
});

describe("reduceUpdate — chunks without a messageId", () => {
  // Hermes's slash-command replies carry no messageId.
  it("appends consecutive id-less chunks of one kind, and splits on anything else", () => {
    const m = run([
      chunk("agent_message_chunk", "Model switched to: x"),
      chunk("agent_message_chunk", "\nProvider: Anthropic"),
      { sessionUpdate: "tool_call", toolCallId: "t", title: "t" },
      chunk("agent_message_chunk", "after"),
    ]);
    expect(m.items.map((i) => ("text" in i ? i.text : i.kind))).toEqual([
      "Model switched to: x\nProvider: Anthropic",
      "tool",
      "after",
    ]);
  });

  it("never merges id-less chunks into a previous turn's item", () => {
    const t1 = run([chunk("agent_message_chunk", "one")], emptyModel(), 1);
    const t2 = run([chunk("agent_message_chunk", "two")], t1, 2);
    expect(t2.items).toHaveLength(2);
  });

  it("does not append an echoed user chunk into our own user bubble", () => {
    const start = applyOps(emptyModel(), [
      { op: "add", item: { kind: "user", id: "u1", text: "hi", turn: 1 } },
    ]);
    const m = run([chunk("user_message_chunk", "queued prompt")], start);
    expect(m.items.map((i) => ("text" in i ? i.text : ""))).toEqual(["hi", "queued prompt"]);
  });
});

describe("reduceUpdate — Hermes's summary of older messages (replay)", () => {
  // acp_adapter/server.py _history_summary_meta: `_meta` on the update itself.
  const marked = (kind: string, text: string, key: string) => ({
    ...chunk(kind, text),
    _meta: { hermes: { [key]: true } },
  });

  it("folds a summary-only message of either role into one summary item", () => {
    const m = run([
      marked("user_message_chunk", "## Goal\nFix the redirect", "compactionSummary"),
      marked("user_message_chunk", "\n## Done\nTests pass", "compactionSummary"),
    ]);
    expect(m.items).toHaveLength(1);
    expect(m.items[0]).toMatchObject({
      kind: "summary",
      text: "## Goal\nFix the redirect\n## Done\nTests pass",
      turn: 1,
    });
    const a = run([marked("agent_message_chunk", "Summary so far", "compactionSummary")]);
    expect(a.items[0]?.kind).toBe("summary");
  });

  it("keeps a message that holds real content too as a normal message", () => {
    const m = run([
      marked("user_message_chunk", "Summary… and now fix the tests", "containsCompactionSummary"),
    ]);
    expect(m.items[0]?.kind).toBe("user");
  });

  it("ignores a summary flag that is not exactly true, and an empty summary", () => {
    const fake = {
      ...chunk("agent_message_chunk", "hi"),
      _meta: { hermes: { compactionSummary: "yes" } },
    };
    expect(run([fake]).items[0]?.kind).toBe("assistant");
    expect(run([marked("user_message_chunk", "", "compactionSummary")]).items).toEqual([]);
  });
});

describe("reduceUpdate — robustness", () => {
  it("returns no ops for malformed or unknown updates", () => {
    const m = run([
      null,
      "x",
      { sessionUpdate: "plan", entries: [] },
      { sessionUpdate: "something_new_in_2027", foo: 1 },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
      { sessionUpdate: "usage_update", used: "1", size: 10 },
      { sessionUpdate: "usage_update", used: 1, size: 0 },
      { sessionUpdate: "tool_call", title: "no id" },
    ]);
    expect(m).toEqual(emptyModel());
  });

  it("renders non-text content blocks as placeholders", () => {
    const m = run([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "x", mimeType: "image/png" },
      },
    ]);
    expect(m.items[0]).toMatchObject({ text: "[image]" });
  });

  it("clears the title on title:null", () => {
    const m = run([
      { sessionUpdate: "session_info_update", title: "T" },
      { sessionUpdate: "session_info_update", title: null },
    ]);
    expect(m.meta.title).toBeUndefined();
  });
});

describe("model helpers", () => {
  it("labels provider:model ids and parses /model replies", () => {
    expect(modelLabel("anthropic:claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelLabel("custom:fixture-model")).toBe("fixture-model");
    expect(modelLabel(undefined)).toBeUndefined();
    expect(modelSwitchedTo("Model switched to: gpt-6-astra\nProvider: ChatGPT")).toBe(
      "gpt-6-astra",
    );
    expect(isModelCommand("/model gpt-6")).toBe(true);
    expect(isModelCommand("/model")).toBe(false);
    expect(isModelCommand("tell me about /model")).toBe(false);
  });
});

describe("modelDisplayName (code review regression)", () => {
  // Both halves of a model id can hold colons; only Hermes's row name is reliable.
  it("uses Hermes's row name, so colons in providers and tags survive", () => {
    expect(
      modelDisplayName({
        currentModelId: "custom:ollama:qwen3:32b",
        availableModels: [{ modelId: "custom:ollama:qwen3:32b", name: "Ollama · qwen3:32b" }],
      }),
    ).toBe("qwen3:32b");
    expect(
      modelDisplayName({
        currentModelId: "anthropic:claude-opus-5-5",
        availableModels: [
          { modelId: "anthropic:claude-opus-5-5", name: "Anthropic · claude-opus-5-5" },
        ],
      }),
    ).toBe("claude-opus-5-5");
    expect(
      modelDisplayName({
        currentModelId: "custom:qwen3:32b",
        availableModels: [{ modelId: "custom:qwen3:32b", name: "qwen3:32b" }],
      }),
    ).toBe("qwen3:32b");
  });

  it("falls back to cutting at the first colon, and returns null with no model", () => {
    expect(
      modelDisplayName({ currentModelId: "openai-codex:gpt-6-astra", availableModels: [] }),
    ).toBe("gpt-6-astra");
    expect(modelDisplayName({ availableModels: [] })).toBeNull();
    expect(modelDisplayName(undefined)).toBeNull();
  });

  it("clears the title with null, never undefined", () => {
    const ops = reduceUpdate(
      emptyModel(),
      { sessionUpdate: "session_info_update", title: null },
      {
        turn: 1,
        newId: (p) => p,
      },
    );
    expect(ops).toEqual([{ op: "meta", patch: { title: null } }]);
  });
});
