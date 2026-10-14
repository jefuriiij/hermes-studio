// Skills named in a message ("/skill-name", anywhere in it). Pure.
//
// Hermes 0.21.5 expands `/skill-name` only in its terminal, gateway and cron
// (agent/skill_commands.py) — `hermes acp` passes it to the model as plain
// text. So the editor asks the model to load the skills with Hermes's own
// `skill_view` tool: Hermes then counts each as used (tools/skill_usage.py
// bump_use — the curator archives skills nobody uses) and applies its
// templates and supporting files, as its terminal does. The "/name" stays in
// the text where it was typed, so the model sees what it is for.

import { isSkillName } from "../shared/skillName";

export { isSkillName };

const NOTE_START = '[The user invoked the "';
const NOTE_END =
  '" skill from the editor. Load it first with skill_view and follow its instructions for this request.]';
const MANY_END =
  " skills from the editor. Load each first with skill_view and follow their instructions for this request.]";

/** The "/word"s of a text, as typed: at the start or after white space,
 *  without trailing punctuation ("/humanizer," → "humanizer"). */
export function slashWords(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (!word.startsWith("/") || word.length < 2) continue;
    const name = word.slice(1).replace(/[.,;:!?)\]]+$/, "");
    if (name && !name.includes("/")) out.push(name);
  }
  return out;
}

/** The text names this skill as "/name" (so it shows there, not as a chip). */
export function mentionsSkill(text: string, skill: string): boolean {
  return slashWords(text).includes(skill);
}

/** "A", "A" and "B", "A", "B" and "C" — each quoted. */
function quoted(names: readonly string[]): string {
  const q = names.map((n) => `"${n}"`);
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} and ${q.at(-1)}`;
}

/** The prompt text for "use these skills for this request". */
export function skillPrompt(skills: string | readonly string[], instruction: string): string {
  const list = [...new Set(typeof skills === "string" ? [skills] : skills)];
  if (list.length === 1) return `${NOTE_START}${list[0]}${NOTE_END}\n\n${instruction}`;
  return `[The user invoked the ${quoted(list)}${MANY_END}\n\n${instruction}`;
}

/** The note back out of a replayed message: the skills and what the user typed. */
export function parseSkillPrompt(
  text: string,
): { skill: string; skills: string[]; instruction: string } | undefined {
  if (!text.startsWith("[The user invoked the ")) return undefined;
  let skills: string[] | undefined;
  let rest: string | undefined;
  const one = text.indexOf(NOTE_END, NOTE_START.length);
  if (text.startsWith(NOTE_START) && one >= 0) {
    skills = [text.slice(NOTE_START.length, one)];
    rest = text.slice(one + NOTE_END.length);
  } else {
    const many = text.indexOf(MANY_END);
    if (many < 0) return undefined;
    const list = text.slice("[The user invoked the ".length, many);
    skills = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    rest = text.slice(many + MANY_END.length);
  }
  if (!skills.length || !skills.every(isSkillName)) return undefined;
  return { skill: skills[0] as string, skills, instruction: rest.replace(/^\n\n/, "") };
}
