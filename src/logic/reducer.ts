// ACP `session/update` → ChatOps. Pure.
//
// Input is the RAW update object straight off the wire (the host dispatches
// from its inbound tap, before the SDK's validation, so nothing is dropped and
// `_meta` survives). Every field is therefore checked here; a malformed or
// unknown update yields no ops and never throws.
//
// Behaviour follows what Hermes 0.21.5 actually sends (captured on the wire and
// read from acp_adapter/events.py, tools.py, server.py):
//   - A reply's reasoning and its answer share ONE messageId, so item ids are
//     derived per kind: `thought:<id>` / `msg:<id>`.
//   - tool_call arrives with NO status although the tool is already running.
//   - tool_call_update also arrives for synthetic ids that were never announced
//     (`edit-approval-N`, `perm-check-N` — permission bookkeeping).
//   - session_info_update can arrive after the turn has ended.

import type {
  ChatItem,
  ChatModel,
  ChatOp,
  MetaPatch,
  ModeChoice,
  ModelChoice,
  SlashCommand,
  ToolStatus,
} from "../shared/chat";
import { buildDiff } from "./diff";
import { contentTexts, findDiff } from "./permissions";
import { visibleChars } from "./safeText";

export interface ReduceCtx {
  /** The current turn number (meta.turn). */
  turn: number;
  /** Generates a unique id with the given prefix (for chunks without a messageId). */
  newId(prefix: string): string;
}

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** The text of a ContentBlock; non-text blocks get a short placeholder. */
function contentText(content: unknown): string {
  if (!isObj(content)) return "";
  switch (content.type) {
    case "text":
      return typeof content.text === "string" ? content.text : "";
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    case "resource_link":
      return typeof content.uri === "string" ? `[${String(content.name ?? content.uri)}]` : "";
    case "resource":
      return "[resource]";
    default:
      return "";
  }
}

function mapToolStatus(v: unknown): ToolStatus | undefined {
  switch (v) {
    case "pending":
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

function findItem(model: ChatModel, id: string): ChatItem | undefined {
  for (let i = model.items.length - 1; i >= 0; i--) {
    const it = model.items[i];
    if (it?.id === id) return it;
  }
  return undefined;
}

export const toolItemId = (toolCallId: string): string => `tool:${toolCallId}`;

export function reduceUpdate(model: ChatModel, update: unknown, ctx: ReduceCtx): ChatOp[] {
  if (!isObj(update)) return [];
  if (
    (update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "user_message_chunk") &&
    isCompactionSummary(update)
  ) {
    return summaryChunk(model, update, ctx);
  }
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return textChunk(model, update, ctx, "assistant", "msg");
    case "agent_thought_chunk":
      return textChunk(model, update, ctx, "thought", "thought");
    case "user_message_chunk":
      return textChunk(model, update, ctx, "user", "user-echo");
    case "tool_call":
      return toolCall(model, update, ctx);
    case "tool_call_update":
      return toolCallUpdate(model, update);
    case "usage_update": {
      const used = update.used;
      const size = update.size;
      if (typeof used !== "number" || typeof size !== "number") return [];
      if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return [];
      return [{ op: "meta", patch: { usage: { used: Math.max(0, used), size } } }];
    }
    case "session_info_update": {
      // null, not undefined: undefined keys vanish crossing the webview bridge.
      if (update.title === null) return [{ op: "meta", patch: { title: null } }];
      const title = typeof update.title === "string" ? update.title.trim() : "";
      return title ? [{ op: "meta", patch: { title } }] : [];
    }
    case "current_mode_update": {
      const mode = str(update.currentModeId);
      return mode ? [{ op: "meta", patch: { mode } }] : [];
    }
    case "available_commands_update": {
      const list = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      const commands: SlashCommand[] = [];
      for (const c of list.slice(0, 100)) {
        if (!isObj(c)) continue;
        const name = str(c.name)?.replace(/^\//, "");
        if (!name || !/^[\w.-]{1,40}$/.test(name)) continue;
        const description = str(c.description)?.slice(0, 200);
        const hint = isObj(c.input) ? str(c.input.hint)?.slice(0, 100) : undefined;
        commands.push({ name, ...(description ? { description } : {}), ...(hint ? { hint } : {}) });
      }
      return [{ op: "meta", patch: { commands } }];
    }
    default:
      // plan, config_option_update, and anything newer: nothing to render yet.
      return [];
  }
}

function textChunk(
  model: ChatModel,
  u: Raw,
  ctx: ReduceCtx,
  kind: "assistant" | "thought" | "user",
  prefix: string,
): ChatOp[] {
  const text = contentText(u.content);
  if (!text) return [];
  const messageId = str(u.messageId);

  if (messageId) {
    const id = `${prefix}:${messageId}`;
    if (findItem(model, id)) return [{ op: "append", id, text }];
    return [{ op: "add", item: makeTextItem(kind, id, text, ctx.turn, messageId) }];
  }

  // No messageId (Hermes's slash-command replies and busy-redirect notes): keep
  // appending to the last item if it is the same kind, from this turn, and also
  // had no id. Anything else in between starts a new item.
  const last = model.items[model.items.length - 1];
  if (last && last.kind === kind && last.turn === ctx.turn && last.id.startsWith(`${prefix}~`)) {
    return [{ op: "append", id: last.id, text }];
  }
  return [{ op: "add", item: makeTextItem(kind, ctx.newId(`${prefix}~`), text, ctx.turn) }];
}

/**
 * Hermes marks a replayed message that is ONLY its summary of older messages
 * with `_meta.hermes.compactionSummary` (either role). A message that holds
 * the summary AND real content is marked `containsCompactionSummary` instead:
 * that one stays a normal message, so nothing real is folded away.
 */
function isCompactionSummary(u: Raw): boolean {
  const meta = u._meta;
  return isObj(meta) && isObj(meta.hermes) && meta.hermes.compactionSummary === true;
}

function summaryChunk(model: ChatModel, u: Raw, ctx: ReduceCtx): ChatOp[] {
  const text = contentText(u.content);
  if (!text) return [];
  const last = model.items[model.items.length - 1];
  if (last?.kind === "summary" && last.turn === ctx.turn) {
    return [{ op: "append", id: last.id, text }];
  }
  return [
    { op: "add", item: { kind: "summary", id: ctx.newId("summary~"), text, turn: ctx.turn } },
  ];
}

function makeTextItem(
  kind: "assistant" | "thought" | "user",
  id: string,
  text: string,
  turn: number,
  messageId?: string,
): ChatItem {
  if (kind === "user") return { kind, id, text, turn };
  return messageId ? { kind, id, text, turn, messageId } : { kind, id, text, turn };
}

/** Output kept per step: Hermes already trims tool results; this bounds the
 *  rest (a whole file read back, a long log). */
const OUTPUT_MAX = 4000;
const LOCATIONS_MAX = 5;

/**
 * A step's content, as the fields to set on its item. ACP: content and
 * locations in an update REPLACE the earlier ones, so a field present in the
 * update is returned even when empty (as an explicit clear), and absent fields
 * leave the item as it was.
 */
function toolDetails(u: Raw): Partial<Extract<ChatItem, { kind: "tool" }>> & { clear: string[] } {
  const out: Partial<Extract<ChatItem, { kind: "tool" }>> & { clear: string[] } = { clear: [] };
  if (Array.isArray(u.content)) {
    const d = findDiff(u.content);
    if (d) out.diff = buildDiff(d.path, d.oldText, d.newText);
    else out.clear.push("diff");
    const text = contentTexts(u.content).join("\n\n").trim();
    if (text) {
      const safe = visibleChars(text);
      out.output =
        safe.length <= OUTPUT_MAX
          ? safe
          : `${safe.slice(0, OUTPUT_MAX)}\n… (${safe.length - OUTPUT_MAX} more characters)`;
    } else {
      out.clear.push("output");
    }
  }
  if (Array.isArray(u.locations)) {
    const locs: { path: string; line?: number }[] = [];
    for (const l of u.locations) {
      if (!isObj(l) || typeof l.path !== "string" || !l.path) continue;
      if (locs.some((x) => x.path === l.path)) continue;
      const line =
        typeof l.line === "number" && Number.isInteger(l.line) && l.line > 0 ? l.line : undefined;
      locs.push(line ? { path: l.path, line } : { path: l.path });
      if (locs.length >= LOCATIONS_MAX) break;
    }
    if (locs.length > 0) out.locations = locs;
    else out.clear.push("locations");
  }
  return out;
}

function withDetails(
  item: Extract<ChatItem, { kind: "tool" }>,
  u: Raw,
): Extract<ChatItem, { kind: "tool" }> {
  const { clear, ...set } = toolDetails(u);
  const next: Record<string, unknown> = { ...item, ...set };
  for (const k of clear) delete next[k];
  return next as Extract<ChatItem, { kind: "tool" }>;
}

function toolCall(model: ChatModel, u: Raw, ctx: ReduceCtx): ChatOp[] {
  const toolCallId = str(u.toolCallId);
  if (!toolCallId) return [];
  const id = toolItemId(toolCallId);
  const title = str(u.title) ?? "tool";
  const toolKind = str(u.kind);
  const status = mapToolStatus(u.status);
  const existing = findItem(model, id);
  if (existing && existing.kind === "tool") {
    return [
      {
        op: "replace",
        item: withDetails(
          {
            ...existing,
            title,
            ...(toolKind ? { toolKind } : {}),
            ...(status ? { status } : {}),
          },
          u,
        ),
      },
    ];
  }
  // Hermes sends tool_call at execution start with no status: it IS running.
  return [
    {
      op: "add",
      item: withDetails(
        {
          kind: "tool",
          id,
          title,
          ...(toolKind ? { toolKind } : {}),
          status: status ?? "running",
          turn: ctx.turn,
        },
        u,
      ),
    },
  ];
}

function toolCallUpdate(model: ChatModel, u: Raw): ChatOp[] {
  const toolCallId = str(u.toolCallId);
  if (!toolCallId) return [];
  const existing = findItem(model, toolItemId(toolCallId));
  // Unknown id: Hermes's synthetic permission ids. Nothing to update.
  if (existing?.kind !== "tool") return [];
  const status = mapToolStatus(u.status);
  const title = str(u.title);
  const toolKind = str(u.kind);
  const hasDetails = Array.isArray(u.content) || Array.isArray(u.locations);
  if (!status && !title && !toolKind && !hasDetails) return [];
  return [
    {
      op: "replace",
      item: withDetails(
        {
          ...existing,
          ...(title ? { title } : {}),
          ...(toolKind ? { toolKind } : {}),
          ...(status ? { status } : {}),
        },
        u,
      ),
    },
  ];
}

/**
 * Ops that close a turn: any tool still `running` becomes `failed`. Hermes
 * closes blocked or denied tools itself, but a crash or a rejected prompt
 * leaves them open, and a spinner that never stops reads as "still working".
 */
export function closeTurnOps(model: ChatModel): ChatOp[] {
  const ops: ChatOp[] = [];
  for (const it of model.items) {
    if (it.kind === "tool" && it.status === "running") {
      ops.push({ op: "replace", item: { ...it, status: "failed" } });
    }
  }
  return ops;
}

/** Display label for a Hermes model id (`provider:model` → `model`). */
export function modelLabel(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const i = modelId.indexOf(":");
  const label = i >= 0 ? modelId.slice(i + 1) : modelId;
  return label || modelId;
}

interface ModelsLike {
  availableModels?:
    | { modelId?: string; name?: string | null; description?: string | null }[]
    | null;
  currentModelId?: string | null;
}

interface ModesLike {
  availableModes?: { id?: string; name?: string | null; description?: string | null }[] | null;
  currentModeId?: string | null;
}

/**
 * Hermes's picker rows as menu choices. A row is named `"<Provider> · <model>"`
 * (named custom endpoints: just `"<model>"`) and described
 * `"Provider: <Provider>"`, plus `" • current"` on the current one — the
 * description is the one place every row names its provider.
 */
export function modelChoices(models: ModelsLike | undefined): ModelChoice[] {
  const rows = Array.isArray(models?.availableModels) ? models.availableModels : [];
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const id = typeof r?.modelId === "string" ? r.modelId.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const sep = name.indexOf(" · ");
    const label = (sep >= 0 ? name.slice(sep + 3).trim() : name) || modelLabel(id) || id;
    const desc = typeof r.description === "string" ? r.description : "";
    const provider =
      /^Provider:\s*(.+?)(?:\s+•.*)?$/.exec(desc.trim())?.[1]?.trim() ||
      (sep >= 0 ? name.slice(0, sep).trim() : "");
    out.push(provider ? { id, label, provider } : { id, label });
  }
  return out;
}

export function modeChoices(modes: ModesLike | undefined): ModeChoice[] {
  const rows = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
  const out: ModeChoice[] = [];
  for (const r of rows) {
    const id = typeof r?.id === "string" ? r.id.trim() : "";
    if (!id || out.some((m) => m.id === id)) continue;
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : id;
    const description = typeof r.description === "string" ? r.description.trim() : "";
    out.push(description ? { id, name, description } : { id, name });
  }
  return out;
}

/** The session's model and mode settings from a session/new or session/load
 *  answer, as a meta patch (`null` clears what the answer does not carry). */
export function sessionSettings(
  res: { models?: ModelsLike | null; modes?: ModesLike | null } | undefined,
): MetaPatch {
  const models = modelChoices(res?.models ?? undefined);
  const modes = modeChoices(res?.modes ?? undefined);
  const modelId = str(res?.models?.currentModelId) ?? null;
  const mode = str(res?.modes?.currentModeId) ?? null;
  return {
    model: modelDisplayName(res?.models ?? undefined),
    modelId,
    models: models.length > 0 ? models : null,
    mode,
    modes: modes.length > 0 ? modes : null,
  };
}

/** The choice a typed `/model <name>` landed on, when exactly one matches. */
export function matchModel(choices: readonly ModelChoice[], name: string): string | undefined {
  const n = name.trim();
  if (!n) return undefined;
  const hits = choices.filter((c) => c.id === n || c.label === n || c.id.endsWith(`:${n}`));
  return hits.length === 1 ? hits[0]?.id : undefined;
}

/**
 * The header's model name for a session/new response.
 *
 * Model ids are `<provider>:<model>`, but both halves can contain colons:
 * named custom providers are `custom:<key>` (Ollama → `custom:ollama:qwen3:32b`)
 * and model tags have them too (`qwen3:32b`, `deepseek-r1:free`). Only Hermes
 * knows where the provider ends, so read the name Hermes gave the current row —
 * `"<Provider> · <model>"` or plain `"<model>"` — and cut at the first colon
 * only when no row matches.
 */
export function modelDisplayName(models: ModelsLike | undefined): string | null {
  const id = models?.currentModelId;
  if (!id) return null;
  const row = models?.availableModels?.find((m) => m.modelId === id);
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  if (name) {
    const sep = name.indexOf(" · ");
    return sep >= 0 ? name.slice(sep + 3).trim() || name : name;
  }
  return modelLabel(id) ?? null;
}

/** Hermes's reply to `/model <name>` is "Model switched to: <name>\nProvider: …". */
export function modelSwitchedTo(replyText: string): string | undefined {
  const m = /Model switched to:\s*(\S+)/i.exec(replyText);
  return m?.[1];
}

/** True when a prompt is Hermes's `/model <name>` command. */
export function isModelCommand(text: string): boolean {
  return /^\/model\s+\S/i.test(text.trim());
}
