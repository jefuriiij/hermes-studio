// Messages typed while Hermes works (mock board 17). Pure: the controller
// keeps the queue and sends from it.
//
// A queued message goes out when the reply ends by itself. "Send now" hands it
// to the running reply instead: Hermes 0.21.5 treats a text-only prompt that
// arrives mid-turn as a correction (acp_adapter/server.py _claim_turn_or_queue
// → agent.redirect: the model request in flight is dropped and retried with
// it; during a tool it waits for the tool). That second prompt ends at once
// with one text chunk without a messageId — "Redirected the active turn with
// your correction." — or, when the turn was just ending, "Queued for the next
// turn. (N queued)": Hermes then runs it right after, echoing it as a user
// message chunk.

import type { Attachment } from "./attachments";

export type Absorbed = "redirected" | "queued";

/** Hermes's answer to a prompt sent into a running reply, if `text` is one. */
export function absorbedReply(text: string): Absorbed | undefined {
  const t = text.trim();
  if (t === "Redirected the active turn with your correction.") return "redirected";
  if (/^Queued for the next turn\. \(\d+ queued\)$/.test(t)) return "queued";
  return undefined;
}

/** Only text reaches a running reply: Hermes redirects text-only prompts. */
export function canSendNow(attachments: readonly Attachment[]): boolean {
  return attachments.every((a) => a.block.type === "text");
}
