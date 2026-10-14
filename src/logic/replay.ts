// A replayed user message (session/load) as the user wrote it. Pure.
//
// Hermes stores a text-only prompt as its text blocks joined by "\n"
// (acp_adapter/content.py _extract_text), so a replay carries the notes the
// editor added: the "/" skill note in front, the current-file note at the
// end. Live, those show as chips; this gives a replay the same chips.

import type { SentChip } from "../shared/chat";
import { mentionsSkill, parseSkillPrompt } from "./skills";

export function cleanReplayedUser(raw: string): { text: string; chips: SentChip[] } {
  let text = raw;
  const chips: SentChip[] = [];

  const skill = parseSkillPrompt(text);
  if (skill) {
    text = skill.instruction;
    // A skill typed in the text ("… maybe use /name") shows there; one picked
    // the old way (before the text) comes back as a chip.
    for (const s of skill.skills) {
      if (!mentionsSkill(text, s)) chips.push({ kind: "skill", label: s });
    }
  }

  // The current-file note is the last block: "[VS Code: … working in X, line N. …]"
  // or "[VS Code: the user has lines a–b of X selected. …]" + a fenced selection.
  const at = text.lastIndexOf("\n[VS Code: the user ");
  if (at >= 0) {
    const tail = text.slice(at + 1);
    const working =
      /^\[VS Code: the user is working in (.+), line \d+\. It may or may not be related to the request\.\]$/.exec(
        tail,
      );
    const selected =
      /^\[VS Code: the user has lines? ([\d–]+) of (.+) selected\. It may or may not be related to the request\.\]\n(`{3,})[^\n]*\n[\s\S]*\n\3$/.exec(
        tail,
      );
    if (working?.[1]) {
      chips.push({ kind: "editor", label: baseName(working[1]) });
      text = text.slice(0, at);
    } else if (selected?.[1] && selected[2]) {
      chips.push({ kind: "editor", label: `${baseName(selected[2])} ${selected[1]}` });
      text = text.slice(0, at);
    }
  }
  return { text: text.replace(/\s+$/, ""), chips };
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}
