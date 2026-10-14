// A skill name as SKILL.md's frontmatter gives it (the "/" menu sends one).
// Shared by the host and the webview. It goes inside quotes in the note the
// host writes for Hermes, so nothing that could end the quote or the bracket.

const SKILL_NAME = /^[\w][\w .+-]{0,99}$/;

export function isSkillName(name: unknown): name is string {
  return typeof name === "string" && SKILL_NAME.test(name) && !name.endsWith(" ");
}
