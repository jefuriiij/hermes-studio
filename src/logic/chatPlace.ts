// Where the chat lives: the side bar view, or an editor tab (Open Chat in
// Editor Tab). There is one chat, in one place at a time; both pages get the
// same model and the same updates, and the page the chat left shows where it
// went. Pure.

import type { WebviewToHost } from "../shared/protocol";

/** What the page the chat has left may still ask for: its panel tabs, and
 *  its buttons that bring the chat back. The rest belongs to the chat (send,
 *  stop, approvals, …) and is dropped: that page no longer shows it. */
const AWAY: ReadonlySet<WebviewToHost["type"]> = new Set<WebviewToHost["type"]>([
  "ready",
  "draft",
  "showChat",
  "moveChatHere",
  "panelOpen",
  "panelSeen",
  "refreshPanels",
]);

export function acceptedAway(type: WebviewToHost["type"]): boolean {
  return AWAY.has(type);
}
