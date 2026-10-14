// What Hermes's `/context` says, for the context pop-up. Pure.
//
// In `hermes acp` (0.21.5) `/context` is a LOCAL command
// (acp_adapter/commands.py `_cmd_context`): no model call, no tokens, and not
// added to the conversation. Its reply, one line each:
//   Conversation: 14 messages            | Conversation is empty (no messages yet).
//     user: 6, assistant: 6, tool: 2, system: 0
//   Model: claude-opus-5-5
//   Provider: anthropic
//   Context usage: ~29,123 / 1,000,000 tokens (2.9%)
//   Compression: ~770,877 tokens until threshold (~800,000, 80%).
//                | Compression: due now (threshold ~800,000, 80%). Run /compress.
//   Tip: run /compress …                 | Auto-compaction is disabled (compression.enabled: false); …
// Hermes gives one total: there is no split by system prompt, tools or memory.

import type { ContextInfo } from "../shared/protocol";

const num = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

export function parseContextReport(text: string): ContextInfo | undefined {
  if (!/Conversation/.test(text)) return undefined;
  const info: ContextInfo = { messages: 0, autoCompress: true };

  const conv = /Conversation: ([\d,]+) messages?/.exec(text);
  if (conv) info.messages = num(conv[1]) ?? 0;
  const roles = /user: (\d+), assistant: (\d+), tool: (\d+)/.exec(text);
  if (roles) {
    info.byRole = { user: Number(roles[1]), assistant: Number(roles[2]), tool: Number(roles[3]) };
  }
  const model = /^Model: (.+)$/m.exec(text)?.[1]?.trim();
  if (model) info.model = model.slice(0, 120);

  const usage = /Context usage: ~([\d,]+)(?: \/ ([\d,]+))? tokens/.exec(text);
  const used = num(usage?.[1]);
  const size = num(usage?.[2]);
  if (used !== undefined) info.used = used;
  if (size !== undefined && size > 0) info.size = size;

  const due = /Compression: due now \(threshold ~([\d,]+)(?:, (\d+)%)?\)/.exec(text);
  const until = /Compression: ~([\d,]+) tokens until threshold \(~([\d,]+)(?:, (\d+)%)?\)/.exec(
    text,
  );
  const bare = /Compression threshold: ~([\d,]+) tokens/.exec(text);
  if (due) {
    info.compressDue = true;
    setThreshold(info, num(due[1]), num(due[2]));
  } else if (until) {
    info.compressIn = num(until[1]);
    setThreshold(info, num(until[2]), num(until[3]));
  } else if (bare) {
    setThreshold(info, num(bare[1]), undefined);
  }
  if (/Auto-compaction is disabled/.test(text)) info.autoCompress = false;
  return info;
}

function setThreshold(
  info: ContextInfo,
  tokens: number | undefined,
  pct: number | undefined,
): void {
  if (tokens !== undefined) info.threshold = tokens;
  if (pct !== undefined) info.thresholdPct = pct;
  else if (tokens !== undefined && info.size)
    info.thresholdPct = Math.round((tokens / info.size) * 100);
}
