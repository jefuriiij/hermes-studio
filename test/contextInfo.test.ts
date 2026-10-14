import { describe, expect, it } from "vitest";

import { parseContextReport } from "../src/logic/contextInfo";
import { isWebviewToHost } from "../src/shared/protocol";

// Built line by line as Hermes 0.21.5's acp_adapter/commands.py _cmd_context does.
const REPORT = [
  "Conversation: 14 messages",
  "  user: 6, assistant: 6, tool: 2, system: 0",
  "Model: claude-opus-5-5",
  "Provider: anthropic",
  "Context usage: ~29,123 / 1,000,000 tokens (2.9%)",
  "Compression: ~770,877 tokens until threshold (~800,000, 80%).",
  "Tip: run /compress to compress manually before the threshold.",
].join("\n");

describe("parseContextReport", () => {
  it("reads the counts, the model, the total and the compression point", () => {
    expect(parseContextReport(REPORT)).toEqual({
      messages: 14,
      byRole: { user: 6, assistant: 6, tool: 2 },
      model: "claude-opus-5-5",
      used: 29_123,
      size: 1_000_000,
      threshold: 800_000,
      thresholdPct: 80,
      compressIn: 770_877,
      autoCompress: true,
    });
  });

  it("an empty conversation", () => {
    const text = [
      "Conversation is empty (no messages yet).",
      "  user: 0, assistant: 0, tool: 0, system: 0",
      "Model: gpt-6-astra",
      "Provider: openai-codex",
      "Compression threshold: ~320,000 tokens",
      "Tip: run /compress to compress manually before the threshold.",
    ].join("\n");
    expect(parseContextReport(text)).toMatchObject({
      messages: 0,
      model: "gpt-6-astra",
      threshold: 320_000,
      autoCompress: true,
    });
  });

  it("compression due now, and automatic compression switched off", () => {
    const due = REPORT.replace(
      /Compression: .*/,
      "Compression: due now (threshold ~800,000, 80%). Run /compress.",
    ).replace(
      /Tip: .*/,
      "Auto-compaction is disabled (compression.enabled: false); /compress still compresses manually.",
    );
    const info = parseContextReport(due);
    expect(info).toMatchObject({ compressDue: true, thresholdPct: 80, autoCompress: false });
    expect(info?.compressIn).toBeUndefined();
  });

  it("works out the percent when Hermes gives only the threshold", () => {
    const text = REPORT.replace(
      /Compression: .*/,
      "Compression: ~770,877 tokens until threshold (~500,000).",
    );
    expect(parseContextReport(text)?.thresholdPct).toBe(50);
  });

  it("gives nothing for text that is not the report", () => {
    expect(parseContextReport("Unknown command")).toBeUndefined();
    expect(parseContextReport("")).toBeUndefined();
  });
});

describe("isWebviewToHost: the context pop-up", () => {
  it("takes the report request and Compress now", () => {
    expect(isWebviewToHost({ type: "contextInfo" })).toBe(true);
    expect(isWebviewToHost({ type: "compress" })).toBe(true);
  });
});
