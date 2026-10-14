// The chat model, shared by the extension host and the webview.
//
// The host owns the model. Every change is expressed as a list of ChatOps, and
// BOTH sides apply those ops with the same applyOps() — the host to keep its
// own model, the webview to keep its copy. The two copies therefore cannot
// drift, and while a reply streams only small deltas cross the bridge instead
// of the whole transcript. A freshly loaded webview gets one full snapshot
// (`init`) and then ops from there.
//
// Pure: no `vscode`, no DOM. Imported by src/logic, src/host and src/webview.

export type ToolStatus = "running" | "completed" | "failed";

/** A message typed while Hermes worked (mock board 17): it goes out when the
 *  reply ends by itself, or at once with "Send now". */
export interface QueuedMessage {
  id: string;
  text: string;
  chips?: SentChip[];
  /** Only text can go into a running reply (Hermes's redirect): a file or an
   *  image waits for the reply to end. */
  canSendNow: boolean;
}

/** What the composer's "+" added to a sent message, as its bubble shows it. */
export interface SentChip {
  /** "editor": the file you were in, which went along on its own; "skill":
   *  the skill picked from the "/" menu (its name is the label). */
  kind: "file" | "selection" | "problems" | "git" | "image" | "editor" | "skill";
  label: string;
  /** Images only: the chip id, to ask the host for the picture. */
  id?: string;
  /** Images only: "461×398". */
  size?: string;
}

export type ChatItem =
  /** `notSent`: stopped before Hermes was ready, so the prompt never went out.
   *  `attachments`: what the composer's "+" added (their content went to Hermes);
   *  an image keeps its chip `id`, which asks the host for its picture. */
  | {
      kind: "user";
      id: string;
      text: string;
      turn: number;
      notSent?: boolean;
      attachments?: SentChip[];
      /** Sent into a reply Hermes was still writing ("Send now" on a queued
       *  message): Hermes reads it at its next step. */
      steered?: boolean;
      /** How long Hermes took to answer it (set when the reply ends; a
       *  replayed session has none). */
      ms?: number;
    }
  /**
   * Hermes stamps a reply's reasoning AND its answer with the SAME messageId
   * (one allocator per session; captured on the wire). Item ids are therefore
   * derived per kind — `msg:<messageId>` / `thought:<messageId>` — and the raw
   * id is kept in `messageId`. Two items sharing an id would make Svelte's
   * keyed each throw `each_key_duplicate` and stop rendering the chat.
   */
  | { kind: "assistant"; id: string; text: string; turn: number; messageId?: string }
  | { kind: "thought"; id: string; text: string; turn: number; messageId?: string }
  /** Hermes's summary of older messages, written when it compressed the chat;
   *  a saved session replays it marked `compactionSummary`. Shown folded. */
  | { kind: "summary"; id: string; text: string; turn: number }
  | {
      kind: "tool";
      id: string;
      title: string;
      toolKind?: string;
      status: ToolStatus;
      turn: number;
      /** What the tool reported (Hermes's formatted result, or "$ command"),
       *  made visible and capped. */
      output?: string;
      /** An edit's change (the full texts stay in the host, for Open diff). */
      diff?: DiffView;
      /** Files it touched, for click-to-open. */
      locations?: { path: string; line?: number }[];
    }
  | {
      kind: "notice";
      id: string;
      level: "info" | "warning" | "error";
      text: string;
      turn: number;
      /** The one fix the notice offers, rendered as a button (never inferred from text). */
      action?: "newChat";
    }
  | PermissionItem;

/**
 * Hermes asks before an edit or a dangerous command. The heading is written by
 * us, never by the model; everything model-controlled (target, detail, diff)
 * is already made visible and capped by the host. `options` are in button
 * order: Deny first.
 */
export interface PermissionItem {
  kind: "permission";
  id: string;
  turn: number;
  /** "edit" (a diff), "command", or "other". */
  action: "edit" | "command" | "other";
  heading: string;
  /** The file (edit) or the command line (command), one line. */
  target?: string;
  /** More model-provided text (the tool title, content), capped. */
  detail?: string;
  diff?: DiffView;
  /** Edits spanning several files (a multi-file patch). */
  files?: number;
  options: { optionId: string; label: string; kind: string }[];
  state: "pending" | "answered" | "expired" | "cancelled";
  /** What was chosen, once answered. */
  answer?: { label: string; allowed: boolean };
}

/** What the header shows. Each failure state maps to one fixing button in the
 *  UI: setupNeeded → Run setup, stopped/error → Restart (+ Show log),
 *  notFound → Set path, noFolder → Open folder. */
export type Connection =
  | { state: "idle" }
  | { state: "noFolder" }
  | { state: "starting"; detail?: string }
  | { state: "ready" }
  /** Hermes has no model provider configured; `hermes model` fixes it. */
  | { state: "setupNeeded"; message: string }
  | { state: "stopped"; message: string }
  | { state: "notFound"; message: string }
  | { state: "error"; message: string };

/** One line of a unified diff. `gap` stands for folded unchanged lines (or a
 *  patch header); numbers are 1-based. Text is already made safe to show. */
export interface DiffLine {
  kind: "add" | "del" | "ctx" | "gap";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffView {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  /** More lines than a card shows: the rest is behind "Open diff". */
  truncated: boolean;
}

/** A row of Hermes's model picker (`availableModels`). */
export interface ModelChoice {
  /** `provider:model`, exactly as Hermes wants it back in session/set_model. */
  id: string;
  /** The model name alone, e.g. "claude-opus-5-5". */
  label: string;
  /** The provider's display name, e.g. "Anthropic"; groups the menu. */
  provider?: string;
}

/** One of Hermes's slash commands, as ACP advertises it. */
export interface SlashCommand {
  name: string;
  description?: string;
  /** What to type after it, e.g. "model name to switch to". */
  hint?: string;
}

/** An edit-approval mode (`availableModes`): Default asks before edits. */
export interface ModeChoice {
  id: string;
  name: string;
  description?: string;
}

export interface Usage {
  /** Estimated tokens in the context window (Hermes: an estimate). */
  used: number;
  /** Context window size. */
  size: number;
}

export interface ChatMeta {
  connection: Connection;
  /** A prompt is outstanding: Send becomes Stop. */
  busy: boolean;
  /** Messages waiting for the reply to end, oldest first. */
  queue?: QueuedMessage[];
  /** Current turn number; increments on every send. */
  turn: number;
  title?: string;
  /** Display label of the current model, e.g. "claude-opus-5-5". */
  model?: string;
  usage?: Usage;
  /** Basename of the workspace folder the session is bound to. */
  folder?: string;
  /** Hermes version from `initialize`. */
  agentVersion?: string;
  /** The Hermes session this chat is, once it exists (marks it in the list). */
  sessionId?: string;
  /** The current model's id (`provider:model`); `model` is its display name. */
  modelId?: string;
  /** Every model Hermes can switch this session to. */
  models?: ModelChoice[];
  /** A model switch is in flight (Hermes can take ~10 s): its display name. */
  switchingModel?: string;
  /** Hermes's own slash commands (`available_commands_update`), for the "/" menu. */
  commands?: SlashCommand[];
  /** The current edit-approval mode's id, and the modes on offer. */
  mode?: string;
  modes?: ModeChoice[];
  /** The last turn failed on a usage/rate limit (or an unanswering provider):
   *  the chat offers to continue on another model. */
  limit?: {
    kind: "limit" | "billing" | "overloaded" | "unavailable";
    provider?: string;
    resets?: string;
  };
}

export interface ChatModel {
  items: ChatItem[];
  meta: ChatMeta;
}

/** Meta fields that can be cleared. */
type ClearableMeta =
  | "title"
  | "model"
  | "usage"
  | "folder"
  | "agentVersion"
  | "sessionId"
  | "modelId"
  | "models"
  | "switchingModel"
  | "mode"
  | "modes"
  | "limit"
  | "queue";

/**
 * A meta change. A clearable field set to `null` is REMOVED. Never `undefined`:
 * VS Code's postMessage serializes with JSON.stringify, which drops keys whose
 * value is undefined — the webview would receive `{}` and keep the old value,
 * and the two copies of the model would drift.
 */
export type MetaPatch = Partial<Omit<ChatMeta, ClearableMeta>> & {
  [K in ClearableMeta]?: ChatMeta[K] | null;
};

export type ChatOp =
  /** Append a new item at the end. */
  | { op: "add"; item: ChatItem }
  /** Append text to the item with this id (assistant / thought / user). */
  | { op: "append"; id: string; text: string }
  /** Replace the item with the same id wholesale. */
  | { op: "replace"; item: ChatItem }
  /** Merge fields into meta; `null` clears a field. */
  | { op: "meta"; patch: MetaPatch }
  /** Drop every item (New chat); meta is kept unless patched separately. */
  | { op: "clear" };

export function emptyModel(): ChatModel {
  return { items: [], meta: { connection: { state: "idle" }, busy: false, turn: 0 } };
}

/**
 * Apply ops to a model, returning a new model. Never mutates the input, so the
 * host can keep the previous model for comparison and Svelte sees fresh
 * references. An op naming an unknown id is ignored — a late or duplicate
 * event must never throw.
 */
export function applyOps(model: ChatModel, ops: readonly ChatOp[]): ChatModel {
  if (ops.length === 0) return model;
  let items = model.items;
  let meta = model.meta;
  let index: Map<string, number> | null = null;
  const indexOf = (id: string): number => {
    if (!index) {
      const built = new Map<string, number>();
      for (let i = 0; i < items.length; i++) built.set((items[i] as ChatItem).id, i);
      index = built;
    }
    return index.get(id) ?? -1;
  };
  let copied = false;
  const writable = (): ChatItem[] => {
    if (!copied) {
      items = items.slice();
      copied = true;
    }
    return items;
  };

  for (const o of ops) {
    switch (o.op) {
      case "add": {
        if (indexOf(o.item.id) !== -1) break; // duplicate id: keep the first
        const w = writable();
        w.push(o.item);
        index?.set(o.item.id, w.length - 1);
        break;
      }
      case "append": {
        const i = indexOf(o.id);
        if (i === -1) break;
        const it = items[i];
        if (!it || !("text" in it)) break;
        writable()[i] = { ...it, text: it.text + o.text };
        break;
      }
      case "replace": {
        const i = indexOf(o.item.id);
        if (i === -1) break;
        writable()[i] = o.item;
        break;
      }
      case "meta": {
        const next: Record<string, unknown> = { ...meta };
        for (const [k, v] of Object.entries(o.patch)) {
          if (v === null) delete next[k];
          else if (v !== undefined) next[k] = v;
        }
        meta = next as unknown as ChatMeta;
        break;
      }
      case "clear":
        items = [];
        copied = true;
        index = new Map();
        break;
    }
  }
  return items === model.items && meta === model.meta ? model : { items, meta };
}

/**
 * Merge consecutive `append`s to the same id into one. The host batches ops for
 * ~30 ms before posting; a streamed reply produces dozens of tiny appends per
 * batch, and this collapses them to one.
 */
export function coalesceOps(ops: readonly ChatOp[]): ChatOp[] {
  const out: ChatOp[] = [];
  for (const o of ops) {
    const last = out[out.length - 1];
    if (o.op === "append" && last?.op === "append" && last.id === o.id) {
      out[out.length - 1] = { op: "append", id: o.id, text: last.text + o.text };
    } else if (o.op === "meta" && last?.op === "meta") {
      out[out.length - 1] = { op: "meta", patch: { ...last.patch, ...o.patch } };
    } else {
      out.push(o);
    }
  }
  return out;
}
