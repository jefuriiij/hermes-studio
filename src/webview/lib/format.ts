// Pure display helpers for the header and the composer. No DOM, no Svelte, and
// imported by relative path (not $shared) so the main test suite can load it.

import type { ChatMeta, Connection, ModeChoice, Usage } from "../../shared/chat";
import type { WebviewAction } from "../../shared/protocol";

const UNITS: readonly (readonly [string, number])[] = [
  ["k", 1e3],
  ["M", 1e6],
  ["B", 1e9],
];

/** 999 → "999", 24100 → "24.1k", 200000 → "200k", 1000000 → "1M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1000) return String(Math.round(n));
  for (let i = 0; i < UNITS.length; i++) {
    const [suffix, div] = UNITS[i] as readonly [string, number];
    const v = Math.round((n / div) * 10) / 10;
    // 999_960 rounds to 1000.0k; roll it over to the next unit instead.
    if (v < 1000 || i === UNITS.length - 1) {
      return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + suffix;
    }
  }
  return String(n);
}

export interface UsagePercent {
  /** Share of the window in use, clamped to 0..1. */
  ratio: number;
  /** "2%", or "<1%" for a sliver, so a fresh chat never claims "0%". */
  label: string;
}

/** The context ring in the composer. `undefined` for a window of unknown size. */
export function usagePercent(u: Usage): UsagePercent | undefined {
  if (!(u.size > 0) || !Number.isFinite(u.used)) return undefined;
  const ratio = Math.min(Math.max(u.used / u.size, 0), 1);
  const pct = Math.round(ratio * 100);
  return { ratio, label: pct === 0 && u.used > 0 ? "<1%" : `${pct}%` };
}

/** Hermes's option kinds: allow_once / allow_always, reject_once / reject_always. */
export const isAllow = (kind: string): boolean => kind.startsWith("allow");

/** The limit banner's words. */
export function limitCopy(limit: NonNullable<ChatMeta["limit"]>): { title: string; body: string } {
  const who = limit.provider ?? "The provider";
  const title =
    limit.kind === "limit"
      ? `${who} usage limit reached`
      : limit.kind === "billing"
        ? `${who}: usage or credits used up`
        : limit.kind === "overloaded"
          ? `${who} is overloaded right now`
          : `${who} is not answering right now`;
  const when = limit.resets
    ? `It resets ${limit.resets.startsWith("in ") ? limit.resets : `at ${limit.resets}`}. `
    : "";
  return { title, body: `${when}Continue on another model and your message is sent again.` };
}

/**
 * Hermes 0.21.5's edit-approval modes, in words like Claude's. All three are
 * about FILE EDITS only (acp_adapter/server.py `_MODES`); sensitive paths and
 * risky commands ask in every mode.
 */
const MODE_WORDS: Record<string, { label: string; description: string; icon: ModeIcon }> = {
  default: { label: "Manual", description: "Hermes asks before each file edit.", icon: "hand" },
  accept_edits: {
    label: "Edit automatically",
    description: "Hermes edits files in this folder without asking.",
    icon: "code",
  },
  dont_ask: { label: "Auto", description: "Hermes edits any file without asking.", icon: "bolt" },
};

export type ModeIcon = "hand" | "code" | "bolt" | "shield";

/** The mode chip's short name; a mode this build does not know keeps
 *  Hermes's own name. */
export function modeLabel(mode: ModeChoice | undefined): string {
  if (!mode) return "Manual";
  return MODE_WORDS[mode.id]?.label ?? mode.name;
}

export function modeDescription(mode: ModeChoice): string | undefined {
  return MODE_WORDS[mode.id]?.description ?? mode.description;
}

export function modeIcon(mode: ModeChoice | undefined): ModeIcon {
  return (mode && MODE_WORDS[mode.id]?.icon) || (mode ? "shield" : "hand");
}

/** "11.3k of 1M tokens in context (1%), estimated by Hermes". */
export function usageTooltip(u: Usage): string {
  const pct = u.size > 0 ? ` (${Math.round((u.used / u.size) * 100)}%)` : "";
  return `${formatTokens(u.used)} of ${formatTokens(u.size)} tokens in context${pct}, estimated by Hermes`;
}

export type Tone = "muted" | "busy" | "ok" | "warn" | "error";

export interface FixButton {
  label: string;
  action: WebviewAction;
  primary: boolean;
}

export interface ConnectionView {
  text: string;
  tone: Tone;
  /** Host-written explanation for failure states, shown under the header. */
  message?: string;
  buttons: FixButton[];
}

/** One fixing button per failure state (the Connection doc in chat.ts). */
export function describeConnection(c: Connection, busy: boolean): ConnectionView {
  switch (c.state) {
    case "idle":
      return { text: "Not started", tone: "muted", buttons: [] };
    case "noFolder":
      return {
        text: "No folder open",
        tone: "muted",
        message: "Open a folder to chat with Hermes.",
        buttons: [{ label: "Open folder", action: "openFolder", primary: true }],
      };
    case "starting":
      return { text: "Starting Hermes…", tone: "busy", buttons: [] };
    case "ready":
      return busy
        ? { text: "Working…", tone: "busy", buttons: [] }
        : { text: "Ready", tone: "ok", buttons: [] };
    case "setupNeeded":
      return {
        text: "Setup needed",
        tone: "warn",
        message: c.message,
        // Retry covers setup done outside the Run setup terminal (plan §5.8).
        buttons: [
          { label: "Run setup", action: "setup", primary: true },
          { label: "Retry", action: "restart", primary: false },
        ],
      };
    case "stopped":
      return {
        text: "Stopped",
        tone: "error",
        message: c.message,
        buttons: [
          { label: "Restart", action: "restart", primary: true },
          { label: "Show log", action: "showLog", primary: false },
        ],
      };
    case "notFound":
      return {
        text: "Hermes not found",
        tone: "error",
        message: c.message,
        // Retry after installing Hermes; changing the path setting also retries.
        buttons: [
          { label: "Set path", action: "setPath", primary: true },
          { label: "Retry", action: "restart", primary: false },
        ],
      };
    case "error":
      return {
        text: "Error",
        tone: "error",
        message: c.message,
        buttons: [
          { label: "Restart", action: "restart", primary: true },
          { label: "Show log", action: "showLog", primary: false },
        ],
      };
    default: {
      // A newer host state this build does not know: say so rather than crash.
      const unknown: never = c;
      void unknown;
      return { text: "Unknown state", tone: "muted", buttons: [] };
    }
  }
}

/** States in which a send cannot possibly work until the user fixes something
 *  (or, while a model switch runs, until it is done). */
export function canSend(meta: ChatMeta): boolean {
  const s = meta.connection.state;
  return s !== "noFolder" && s !== "notFound" && s !== "setupNeeded" && !meta.switchingModel;
}

/** The composer placeholder doubles as the reason Send is disabled. */
export function composerPlaceholder(meta: ChatMeta): string {
  if (meta.switchingModel) return `Switching to ${meta.switchingModel}…`;
  switch (meta.connection.state) {
    case "noFolder":
      return "Open a folder to chat with Hermes";
    case "notFound":
      return "Set the Hermes path to start chatting";
    case "setupNeeded":
      return "Run setup to start chatting";
    default:
      return meta.busy
        ? "Hermes is working — Enter queues your message"
        : "Ask Hermes… (@ to add a file, / for skills)";
  }
}
