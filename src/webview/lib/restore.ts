// Which prompts go back into the composer after a batch of ops. Pure, and
// imported by relative path (not $shared) so the main test suite can load it.
//
// Stop on a turn that never reached Hermes marks its user bubble `notSent`
// (plan §5.5), and the text should return to the composer. The protocol has no
// message for that; the webview derives it from the `replace` op that flips
// notSent from false to true. Never from `init`: a reload must not re-insert
// old text.
//
// The ops are walked in order: a send that fails at once (e.g. after three
// crashes in a minute) puts the bubble's `add` and its `notSent` replace in the
// SAME batch, so an item must be known from earlier ops, not only from `before`.

import type { ChatItem, ChatModel, ChatOp } from "../../shared/chat";

export function stoppedPromptTexts(before: ChatModel, ops: readonly ChatOp[]): string[] {
  const known = new Map<string, ChatItem>(before.items.map((it) => [it.id, it]));
  const texts: string[] = [];
  for (const o of ops) {
    if (o.op === "clear") {
      known.clear();
      continue;
    }
    if (o.op === "add") {
      if (!known.has(o.item.id)) known.set(o.item.id, o.item);
      continue;
    }
    if (o.op !== "replace") continue;
    const prev = known.get(o.item.id);
    known.set(o.item.id, o.item);
    if (o.item.kind !== "user" || !o.item.notSent) continue;
    if (prev?.kind !== "user" || prev.notSent) continue;
    texts.push(o.item.text);
  }
  return texts;
}
