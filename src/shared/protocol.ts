// Messages between the extension host and the webview. Types only, shared by
// both sides. The host validates every WebviewToHost message before acting on
// it (isWebviewToHost) — the webview renders model output, so treat anything
// coming from it as untrusted.

import type { ChatModel, ChatOp } from "./chat";
import { type EffortLevel, type EffortState, isEffortLevel } from "./effort";
import { isSkillName } from "./skillName";

/** A workspace path for the "@" list (forward slashes, relative). */
export interface PathHit {
  path: string;
  kind: "file" | "folder";
}
import type { HubSkill, PanelsView } from "./panels";

/** A memory proposal's id (Hermes: short hex). Never "all": Hermes reads
 *  `/memory approve all` as every proposal. */
export const PENDING_ID = /^(?!all$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/i;
/** A Skills Hub identifier: "official/mlops/trl-fine-tuning", "skills-sh/org/repo/pdf". */
export const HUB_IDENTIFIER = /^[A-Za-z0-9][\w.@:+/-]{0,299}$/;

/** One saved Hermes session, as `session/list` describes it. */
export interface SessionSummary {
  id: string;
  /** Hermes always sends one (falls back to the first prompt); may be absent. */
  title?: string;
  /** ISO 8601. */
  updatedAt?: string;
}

/** A chat left working while you are in another one (it keeps running in
 *  Hermes). `waiting`: it asked for an approval that waits for you. `done` /
 *  `stopped`: it ended while you were not looking at it, and you have not
 *  looked since (host/notifier.ts). */
export interface BackgroundSession {
  id: string;
  title: string;
  state: "working" | "waiting" | "done" | "stopped";
}

/** The Sessions view's data. Not part of the chat model: fetched on demand. */
export interface SessionList {
  items: SessionSummary[];
  /** More pages exist; pass this back in `listSessions` to get the next. */
  nextCursor?: string;
  loading: boolean;
  error?: string;
}

export type HostToWebview =
  /** Full snapshot. Sent in reply to every `ready` (a webview can reload). */
  | { type: "init"; model: ChatModel }
  /** Incremental changes, in order, batched by the host. */
  | { type: "ops"; ops: ChatOp[] }
  /** Put keyboard focus in the composer (Open Chat command). */
  | { type: "focusComposer" }
  /** The session list, whenever it changes (loading, a page arrived, an error). */
  | { type: "sessions"; list: SessionList }
  /** Show the Sessions view (the History button in the view's title bar). */
  | { type: "showSessions" }
  /** Scroll to a waiting approval card and focus its Deny button. */
  | { type: "focusPermission"; id: string }
  /** What the composer's "+" has gathered for the next message. */
  | { type: "context"; items: ContextChip[]; images: boolean }
  /** The picture behind an image chip (null: the host no longer has it). */
  | { type: "imagePreview"; id: string; image: ImagePreview | null }
  /** Subscription limits per provider, from `hermes usage` (the model menu). */
  | { type: "accountUsage"; usage: AccountUsage }
  /** The file you are in, which goes along with the next message (null: none). */
  | { type: "editorContext"; file: EditorChip | null }
  /** Hermes's reasoning effort setting, for the modes pop-up. */
  | { type: "effort"; effort: EffortState }
  /** Hermes's `/context` report for the context pop-up; null: not now
   *  (Hermes is busy or not started — the pop-up shows the ring's numbers). */
  | { type: "contextInfo"; info: ContextInfo | null }
  /** The Hermes panels (the tabs next to Chat), after every read of Hermes's files. */
  | { type: "panels"; view: PanelsView }
  /** The chats working in the background, whenever that changes. */
  | { type: "background"; sessions: BackgroundSession[] }
  /** A rename or delete from the Sessions pop-up finished (or was refused). */
  | { type: "sessionAction"; result: SessionActionResult }
  /** The "@" list's answer to fileSearch `seq` (an older answer is dropped). */
  | { type: "fileResults"; seq: number; items: PathHit[] }
  /** Whether the chat lives in this webview. false: it is in the editor tab,
   *  and this view (the side bar) says so; its panel tabs keep working. */
  | { type: "chatPlace"; here: boolean }
  /** The composer's text, from the webview the chat moved away from. */
  | { type: "takeDraft"; text: string; skill?: string }
  /** Queued messages of a chat you left: back into the composer (in front
   *  of what it holds). */
  | { type: "draftBack"; text: string; skill?: string }
  /** The answer to checkPaths: which paths are real files. */
  | { type: "paths"; known: Record<string, boolean> }
  /** A memoryReview is done (`ids`: every proposal it named). `unavailable`:
   *  this Hermes can't be asked from here; the tab points to the CLI. */
  | { type: "memoryReviewed"; ids: string[]; ok: boolean; message?: string; unavailable?: boolean }
  /** The Skills Hub's answer to hubSearch `seq` (an older answer is dropped). */
  | { type: "hubResults"; seq: number; items: HubSkill[]; error?: string }
  /** A hubInstall is done. */
  | { type: "hubInstalled"; identifier: string; ok: boolean; message?: string };

export interface SessionActionResult {
  action: "rename" | "delete";
  sessionId: string;
  ok: boolean;
  /** "Renamed.", "Deleted “…”.", or why not, in plain words. */
  message: string;
}

/** What `/context` says (logic/contextInfo.ts). One total: Hermes has no
 *  split by system prompt, tools or memory. */
export interface ContextInfo {
  messages: number;
  byRole?: { user: number; assistant: number; tool: number };
  model?: string;
  /** Estimated tokens in context, and the window. */
  used?: number;
  size?: number;
  /** Where Hermes compresses, in tokens and percent of the window. */
  threshold?: number;
  thresholdPct?: number;
  /** Tokens left until then; `compressDue`: past it already. */
  compressIn?: number;
  compressDue?: boolean;
  /** false: compression.enabled is off (only /compress compresses). */
  autoCompress: boolean;
}

/** The composer's chip for the file you are in. */
export interface EditorChip {
  /** "login.ts" or "login.ts 40–52". */
  label: string;
  /** Tooltip: the path, the line or the selected lines. */
  detail: string;
  /** You clicked ×: it stays out until you move to another file. */
  excluded: boolean;
}

/** One limit window of a subscription, e.g. the 5-hour session or the week. */
export interface UsageWindow {
  label: string;
  /** 0–100; absent when the provider gives only a text `detail`. */
  usedPercent?: number;
  /** ISO 8601. */
  resetsAt?: string;
  detail?: string;
}

export interface ProviderUsage {
  plan?: string;
  windows: UsageWindow[];
  /** Extra lines, e.g. "You have 1 reset banked". */
  details: string[];
  /** ISO 8601. */
  fetchedAt?: string;
}

export interface AccountUsage {
  /** By provider slug (the part of a model id before ":"). null: that
   *  provider has no usage to show (no subscription, or no usage endpoint). */
  byProvider: Record<string, ProviderUsage | null>;
  /** Slugs being fetched right now. */
  loading: string[];
}

/** One thing the composer's "+" attached, as a chip. */
export interface ContextChip {
  id: string;
  kind: "file" | "selection" | "problems" | "git" | "image";
  label: string;
  detail?: string;
  /** An image's pixel size, "461×398". */
  size?: string;
}

export interface ImagePreview {
  label: string;
  size?: string;
  mimeType: string;
  /** Base64. */
  data: string;
}

export type WebviewAction = "restart" | "setup" | "setPath" | "showLog" | "openFolder";

export type WebviewToHost =
  | { type: "ready" }
  /** `skills`: named in the text ("/name") — Hermes loads them for this
   *  message. */
  | { type: "send"; text: string; skills?: string[] }
  | { type: "cancel" }
  | { type: "newChat" }
  | { type: "action"; action: WebviewAction }
  | { type: "openLink"; href: string }
  /** First page, or the page after `cursor` (appended to what is shown). */
  | { type: "listSessions"; cursor?: string }
  | { type: "openSession"; sessionId: string }
  | { type: "setModel"; modelId: string }
  | { type: "setMode"; modeId: string }
  /** After a limit: switch to this model and send the failed message again. */
  | { type: "continueWith"; modelId: string }
  | { type: "dismissLimit" }
  /** A click on an approval card's button. */
  | { type: "permission"; id: string; optionId: string }
  /** The full diff behind a card or step, in VS Code's diff editor. */
  | { type: "openDiff"; id: string }
  /** A file named in a card or step (Hermes's path, maybe relative). */
  | { type: "openFile"; path: string; line?: number }
  /** The "+" menu: gather this kind of context (the host shows any picker). */
  | { type: "addContext"; kind: ContextChip["kind"] }
  | { type: "removeContext"; id: string }
  /** An image pasted into the composer, base64. */
  | { type: "pasteImage"; mimeType: string; data: string }
  /** Show the picture of an image chip (in the composer or on a sent message). */
  | { type: "previewImage"; id: string }
  /** The model menu opened: fetch subscription limits unless they are fresh. */
  | { type: "refreshUsage" }
  /** The × on the current-file chip, or a click to include it again. */
  | { type: "toggleEditorContext" }
  /** The modes pop-up opened: read the effort setting. */
  | { type: "refreshEffort" }
  /** A dot in the pop-up: save this effort in Hermes's config. */
  | { type: "setEffort"; level: EffortLevel }
  /** The context ring was clicked: ask Hermes's `/context` (idle only). */
  | { type: "contextInfo" }
  /** "Compress now" in the context pop-up: send `/compress` as a message. */
  | { type: "compress" }
  /** A click in a panel tab: open what this key of the last `panels` view names. */
  | { type: "panelOpen"; key: string }
  /** The Learning tab is on screen: what Hermes changed so far is seen. */
  | { type: "panelSeen" }
  /** A panel tab opened, or its ↻: read Hermes's files again. */
  | { type: "refreshPanels" }
  /** The Memory tab's buttons: approve one proposal (if any), then reject
   *  these — only once the approve worked ("Use this one" of 3 versions). */
  | { type: "memoryReview"; approve?: string; reject: string[] }
  /** "Get more" skills: search the Skills Hub (empty + official: Hermes's own). */
  | { type: "hubSearch"; query: string; official: boolean; seq: number }
  /** Install one skill of the last hubResults (Hermes scans it first). */
  | { type: "hubInstall"; identifier: string }
  /** The Sessions pop-up's rename (✏ or F2): Hermes checks the title too. */
  | { type: "renameSession"; sessionId: string; title: string }
  /** The Sessions pop-up's delete, after its confirmation (🗑 or Del). */
  | { type: "deleteSession"; sessionId: string }
  /** The "@" list: workspace paths for what was typed after the "@". */
  | { type: "fileSearch"; query: string; seq: number }
  /** An "@" pick: attach this workspace file (relative path) to the message. */
  | { type: "mentionFile"; path: string }
  /** Files dragged in with Shift (VS Code's Explorer, an editor tab): their URIs. */
  | { type: "dropUris"; uris: string[] }
  /** The composer's text (and picked skill) as it changes, so it can move
   *  with the chat between the side bar and the editor tab. */
  | { type: "draft"; text: string; skill?: string }
  /** The side bar's "Show the chat": bring the editor tab to the front. */
  | { type: "showChat" }
  /** The side bar's "Move it back here": close the tab, the chat returns. */
  | { type: "moveChatHere" }
  /** A queued message's "Send now": into the running reply, or sent if idle. */
  | { type: "queueSendNow"; id: string }
  /** A queued message's × (or ✏, `restore`: its files go back to the chips). */
  | { type: "queueRemove"; id: string; restore?: boolean }
  /** Path-like `code` in a reply: which are real files (they become links). */
  | { type: "checkPaths"; paths: string[] };

const CONTEXT_KINDS: ReadonlySet<string> = new Set([
  "file",
  "selection",
  "problems",
  "git",
  "image",
]);
export const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** Base64 of about 3.7 MB of image; the host checks it again. */
export const MAX_IMAGE_CHARS = 5_000_000;

const ACTIONS: ReadonlySet<string> = new Set<WebviewAction>([
  "restart",
  "setup",
  "setPath",
  "showLog",
  "openFolder",
]);

/** Upper bound for one prompt from the composer (Hermes accepts 50 MiB lines;
 *  this is a sanity limit against a runaway paste, not a protocol limit). */
export const MAX_PROMPT_CHARS = 200_000;

/** Session ids and cursors are UUIDs in Hermes, model ids `provider:model`
 *  strings, mode ids short words; this only bounds garbage. */
const MAX_ID_CHARS = 256;
const isId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS;

/** Structural check for a message from the webview. */
export function isWebviewToHost(m: unknown): m is WebviewToHost {
  if (typeof m !== "object" || m === null) return false;
  const t = (m as { type?: unknown }).type;
  switch (t) {
    case "ready":
    case "cancel":
    case "newChat":
    case "dismissLimit":
    case "refreshUsage":
    case "toggleEditorContext":
    case "refreshEffort":
    case "contextInfo":
    case "compress":
    case "panelSeen":
    case "refreshPanels":
    case "showChat":
    case "moveChatHere":
      return true;
    case "draft": {
      const { text, skill } = m as { text?: unknown; skill?: unknown };
      return (
        typeof text === "string" &&
        text.length <= MAX_PROMPT_CHARS &&
        (skill === undefined || isSkillName(skill))
      );
    }
    case "panelOpen": {
      // Keys carry a path (file:<line>:<path>); the host opens only its own.
      const key = (m as { key?: unknown }).key;
      return typeof key === "string" && key.length > 0 && key.length <= 4200;
    }
    case "setEffort":
      return isEffortLevel((m as { level?: unknown }).level);
    case "send": {
      const { text, skills } = m as { text?: unknown; skills?: unknown };
      return (
        typeof text === "string" &&
        text.length <= MAX_PROMPT_CHARS &&
        (skills === undefined ||
          (Array.isArray(skills) && skills.length <= 10 && skills.every(isSkillName)))
      );
    }
    case "fileSearch": {
      const { query, seq } = m as { query?: unknown; seq?: unknown };
      return typeof query === "string" && query.length <= 200 && Number.isSafeInteger(seq);
    }
    case "memoryReview": {
      const { approve, reject } = m as { approve?: unknown; reject?: unknown };
      const id = (v: unknown): v is string => typeof v === "string" && PENDING_ID.test(v);
      return (
        (approve === undefined || id(approve)) &&
        Array.isArray(reject) &&
        reject.length <= 50 &&
        reject.every(id) &&
        (approve === undefined || !reject.includes(approve)) &&
        (approve !== undefined || reject.length > 0)
      );
    }
    case "hubSearch": {
      const { query, official, seq } = m as { query?: unknown; official?: unknown; seq?: unknown };
      return (
        typeof query === "string" &&
        query.length <= 100 &&
        typeof official === "boolean" &&
        Number.isSafeInteger(seq)
      );
    }
    case "hubInstall": {
      const identifier = (m as { identifier?: unknown }).identifier;
      return typeof identifier === "string" && HUB_IDENTIFIER.test(identifier);
    }
    case "dropUris": {
      const uris = (m as { uris?: unknown }).uris;
      return (
        Array.isArray(uris) &&
        uris.length > 0 &&
        uris.length <= 50 &&
        uris.every((u) => typeof u === "string" && u.length > 0 && u.length <= 2048)
      );
    }
    case "mentionFile": {
      const path = (m as { path?: unknown }).path;
      return typeof path === "string" && path.length > 0 && path.length <= 1024;
    }
    case "action": {
      const a = (m as { action?: unknown }).action;
      return typeof a === "string" && ACTIONS.has(a);
    }
    case "openLink": {
      const href = (m as { href?: unknown }).href;
      return typeof href === "string" && href.length <= 4096;
    }
    case "listSessions": {
      const cursor = (m as { cursor?: unknown }).cursor;
      return cursor === undefined || isId(cursor);
    }
    case "openSession":
    case "deleteSession":
      return isId((m as { sessionId?: unknown }).sessionId);
    case "renameSession": {
      const r = m as { sessionId?: unknown; title?: unknown };
      // Bounded here; the host cleans it and Hermes checks it (≤ 100 characters).
      return isId(r.sessionId) && typeof r.title === "string" && r.title.length <= 1000;
    }
    case "setModel":
    case "continueWith":
      return isId((m as { modelId?: unknown }).modelId);
    case "setMode":
      return isId((m as { modeId?: unknown }).modeId);
    case "permission": {
      const p = m as { id?: unknown; optionId?: unknown };
      return isId(p.id) && isId(p.optionId);
    }
    case "openDiff":
    case "removeContext":
    case "previewImage":
    case "queueSendNow":
      return isId((m as { id?: unknown }).id);
    case "checkPaths": {
      const paths = (m as { paths?: unknown }).paths;
      return (
        Array.isArray(paths) &&
        paths.length > 0 &&
        paths.length <= 50 &&
        paths.every((p) => typeof p === "string" && p.length > 0 && p.length <= 1024)
      );
    }
    case "queueRemove": {
      const r = m as { id?: unknown; restore?: unknown };
      return isId(r.id) && (r.restore === undefined || typeof r.restore === "boolean");
    }
    case "addContext": {
      const k = (m as { kind?: unknown }).kind;
      return typeof k === "string" && CONTEXT_KINDS.has(k);
    }
    case "pasteImage": {
      const p = m as { mimeType?: unknown; data?: unknown };
      return (
        typeof p.mimeType === "string" &&
        IMAGE_TYPES.has(p.mimeType) &&
        typeof p.data === "string" &&
        p.data.length > 0 &&
        p.data.length <= MAX_IMAGE_CHARS &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(p.data)
      );
    }
    case "openFile": {
      const f = m as { path?: unknown; line?: unknown };
      const lineOk =
        f.line === undefined ||
        (typeof f.line === "number" && Number.isInteger(f.line) && f.line >= 1 && f.line < 1e7);
      return typeof f.path === "string" && f.path.length > 0 && f.path.length <= 4096 && lineOk;
    }
    default:
      return false;
  }
}
