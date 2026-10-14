// When and how Hermes Studio tells you that Hermes needs you, finished, or
// stopped (mock board 16). Pure: host/notifier.ts shows what this decides.
//
// Never while you are looking at that chat. Inside VS Code, a notification
// when the chat is not on screen; on Windows, also a Windows notification
// when VS Code is not the front window. A notification never answers an
// approval: it only takes you to the card.

import type { ChatMeta } from "../shared/chat";
import { tookText } from "../shared/time";

export { tookText };

export type Attention =
  | {
      kind: "approval";
      sessionId: string;
      /** The card to focus (its Deny button). */
      cardId: string;
      title: string;
      /** "Edit: src/auth/oauth.ts" */
      what: string;
      background: boolean;
    }
  | { kind: "done"; sessionId: string; title: string; ms: number; background: boolean }
  | { kind: "stopped"; sessionId: string; title: string; why: string; background: boolean };

export interface Looking {
  /** The chat (side bar view or editor tab) is on screen. */
  chatVisible: boolean;
  /** VS Code is the front window. */
  windowFocused: boolean;
}

export interface NotifySettings {
  /** hermesStudio.notifications */
  enabled: boolean;
  /** hermesStudio.windowsNotifications, and the platform can show them. */
  windows: boolean;
}

export interface Channels {
  vscode: boolean;
  windows: boolean;
  /** Counts on the view until you look at that chat (a finished / stopped one). */
  unseen: boolean;
}

export function channels(a: Attention, look: Looking, s: NotifySettings): Channels {
  // A chat in the background is never the one on screen.
  const onScreen = !a.background && look.chatVisible && look.windowFocused;
  if (onScreen) return { vscode: false, windows: false, unseen: false };
  return {
    vscode: s.enabled && (a.background || !look.chatVisible),
    windows: s.enabled && s.windows && !look.windowFocused,
    unseen: a.kind !== "approval",
  };
}

/** Why a provider gave up, in a few words: "Claude usage limit — resets at 14:00". */
export function limitReason(limit: NonNullable<ChatMeta["limit"]>): string {
  const who = limit.provider ?? "The provider";
  const what =
    limit.kind === "limit"
      ? `${who} usage limit`
      : limit.kind === "billing"
        ? `${who}: usage or credits used up`
        : limit.kind === "overloaded"
          ? `${who} is overloaded`
          : `${who} is not answering`;
  const r = limit.resets;
  return r ? `${what} — resets ${r.startsWith("in ") ? r : `at ${r}`}` : what;
}

/**
 * Why a turn that ended normally still did not finish the job, or undefined
 * when it did. `limit`: what the chat's banner shows for this turn.
 */
export function stopWhy(
  stopReason: string,
  limit: ChatMeta["limit"] | undefined,
): string | undefined {
  switch (stopReason) {
    case "end_turn":
      return limit ? limitReason(limit) : undefined;
    case "max_tokens":
      return "Hermes stopped early (max tokens)";
    case "max_turn_requests":
      return "Hermes stopped early (too many steps)";
    case "refusal":
      return "Hermes no longer has this session";
    case "cancelled":
      return "The request was cancelled";
    default:
      return undefined;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** VS Code's own notification (the corner pop-up). */
export function vscodeMessage(a: Attention): {
  level: "info" | "warning";
  text: string;
  action: "Show" | "Open";
} {
  const title = clip(a.title, 60);
  switch (a.kind) {
    case "approval":
      return {
        level: "warning",
        text: a.background
          ? `Hermes needs your OK in “${title}”: ${clip(a.what, 100)}`
          : `Hermes is waiting for your approval — ${clip(a.what, 120)}`,
        action: "Show",
      };
    case "done":
      return { level: "info", text: `Hermes finished “${title}”.`, action: "Open" };
    case "stopped":
      return {
        level: "warning",
        text: `Hermes stopped in “${title}”: ${clip(a.why, 120)}`,
        action: "Open",
      };
  }
}

/** A Windows notification: a bold title, a line, a small line, one button. */
export function windowsMessage(a: Attention): {
  title: string;
  body: string;
  attribution: string;
  action: "Show" | "Open";
} {
  const inChat = `in “${clip(a.title, 60)}”`;
  switch (a.kind) {
    case "approval":
      return {
        title: "Hermes needs your OK",
        body: clip(a.what, 120),
        attribution: inChat,
        action: "Show",
      };
    case "done":
      return {
        title: "Hermes finished",
        body: `“${clip(a.title, 80)}”`,
        attribution: tookText(a.ms),
        action: "Open",
      };
    case "stopped":
      return {
        title: "Hermes stopped",
        body: clip(a.why, 120),
        attribution: inChat,
        action: "Open",
      };
  }
}
