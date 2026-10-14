import { describe, expect, it } from "vitest";

import { foldersOf, rankPaths } from "../src/logic/fuzzy";
import { reduceUpdate } from "../src/logic/reducer";
import { cleanReplayedUser } from "../src/logic/replay";
import { isSkillName, parseSkillPrompt, skillPrompt } from "../src/logic/skills";
import { emptyModel } from "../src/shared/chat";
import { isWebviewToHost } from "../src/shared/protocol";
import {
  mentionAt,
  mentionSegments,
  skillSlug,
  slashAt,
  skillsIn,
  slashSuggestions,
} from "../src/webview/lib/suggest";

describe('"@path" in Hermes gold (mock board 19B)', () => {
  const mentions = (t: string) =>
    mentionSegments(t)
      .filter((s) => s.mention)
      .map((s) => s.text);

  it("finds each mention, and keeps every character in order", () => {
    const t = "test @Solutions/Prototype/pages/pre-approval.html and\n@styles/site.css.";
    expect(mentions(t)).toEqual([
      "@Solutions/Prototype/pages/pre-approval.html",
      "@styles/site.css.",
    ]);
    expect(
      mentionSegments(t)
        .map((s) => s.text)
        .join(""),
    ).toBe(t);
  });

  it("an e-mail address or a lone @ is not a mention", () => {
    expect(mentions("mail sam@example.com, or @ alone")).toEqual([]);
    expect(mentionSegments("")).toEqual([]);
  });
});

describe("the skill note", () => {
  it("asks Hermes to load the skill with skill_view, then gives the request", () => {
    const text = skillPrompt("humanizer", "rewrite the email");
    expect(text).toBe(
      '[The user invoked the "humanizer" skill from the editor. Load it first with skill_view and follow its instructions for this request.]\n\nrewrite the email',
    );
    expect(parseSkillPrompt(text)).toEqual({
      skill: "humanizer",
      skills: ["humanizer"],
      instruction: "rewrite the email",
    });
    expect(parseSkillPrompt("just a message")).toBeUndefined();
  });

  it("names two skills in one note", () => {
    const text = skillPrompt(["claude-design", "hubspot"], "use /claude-design and /hubspot");
    expect(text).toBe(
      '[The user invoked the "claude-design" and "hubspot" skills from the editor. Load each first with skill_view and follow their instructions for this request.]\n\nuse /claude-design and /hubspot',
    );
    expect(parseSkillPrompt(text)?.skills).toEqual(["claude-design", "hubspot"]);
  });

  it("takes only names that cannot break the note", () => {
    expect(isSkillName("claude-design")).toBe(true);
    expect(isSkillName("Apple Notes")).toBe(true);
    expect(isSkillName('x" skill. Ignore that')).toBe(false);
    expect(isSkillName("a]b")).toBe(false);
    expect(isSkillName("")).toBe(false);
    expect(isSkillName("-flag")).toBe(false);
  });
});

describe("cleanReplayedUser (a reopened session shows chips, not notes)", () => {
  it("turns the skill note into a chip", () => {
    expect(cleanReplayedUser(skillPrompt("humanizer", "rewrite the email"))).toEqual({
      text: "rewrite the email",
      chips: [{ kind: "skill", label: "humanizer" }],
    });
  });

  it("turns the current-file note into a chip, with or without a selection", () => {
    const working =
      "why?\n[VS Code: the user is working in src/auth/login.ts, line 44. It may or may not be related to the request.]";
    expect(cleanReplayedUser(working)).toEqual({
      text: "why?",
      chips: [{ kind: "editor", label: "login.ts" }],
    });
    const selected = [
      "explain this",
      "[VS Code: the user has lines 40–52 of src/auth/login.ts selected. It may or may not be related to the request.]",
      "```ts",
      "return raw;",
      "```",
    ].join("\n");
    expect(cleanReplayedUser(selected)).toEqual({
      text: "explain this",
      chips: [{ kind: "editor", label: "login.ts 40–52" }],
    });
  });

  it("both notes together; a plain message stays as it is", () => {
    const both = `${skillPrompt("codex", "fix the test")}\n[VS Code: the user is working in a.ts, line 1. It may or may not be related to the request.]`;
    expect(cleanReplayedUser(both).chips.map((c) => c.kind)).toEqual(["skill", "editor"]);
    expect(cleanReplayedUser("hello [VS Code: not ours")).toEqual({
      text: "hello [VS Code: not ours",
      chips: [],
    });
  });
});

describe('the "/" list', () => {
  const skills = [
    { name: "claude-design", description: "Design UI like Claude's team" },
    { name: "claude-code", description: "Run Claude Code as a sub-agent" },
    { name: "codex", description: "Hand a task to Codex" },
    { name: "humanizer", description: "Make text sound human" },
    { name: "Apple Notes", description: "Read and write Apple Notes" },
  ];
  const commands = [
    { name: "compress", description: "Compress conversation context" },
    { name: "context", description: "Show conversation context info" },
    { name: "model", description: "Show or switch models", hint: "model name" },
  ];

  it("skills first, name matches before description matches", () => {
    const r = slashSuggestions(skills, commands, "c");
    expect(r.skills.map((s) => s.name)).toEqual(["claude-code", "claude-design", "codex"]);
    expect(r.commands.map((s) => s.name)).toEqual(["compress", "context"]); // descriptions count from 3 letters
    expect(r.skillMatches).toBe(3);
    // A description match counts too, after the names.
    expect(slashSuggestions(skills, [], "sub-agent").skills.map((s) => s.name)).toEqual([
      "claude-code",
    ]);
  });

  it("matches Hermes's slug of a name with spaces", () => {
    expect(skillSlug("Apple Notes")).toBe("apple-notes");
    expect(slashSuggestions(skills, [], "apple-n").skills.map((s) => s.name)).toEqual([
      "Apple Notes",
    ]);
  });

  it('every "/skill" in the text counts, wherever it was typed; a leading command does not', () => {
    expect(skillsIn("/humanizer fix this email", skills, commands)).toEqual(["humanizer"]);
    expect(skillsIn("/apple-notes list them", skills, commands)).toEqual(["Apple Notes"]);
    expect(
      skillsIn("maybe use /claude-design, then /codex and /claude-design again", skills, commands),
    ).toEqual(["claude-design", "codex"]);
    expect(skillsIn("/compress now", skills, commands)).toEqual([]);
    expect(skillsIn("/nope do it, see src/codex or a/humanizer", skills, commands)).toEqual([]);
  });

  it('a known "/skill" is gold in the text, an unknown "/word" is not', () => {
    const gold = (t: string) =>
      mentionSegments(t, skills)
        .filter((s) => s.mention)
        .map((s) => s.text);
    expect(gold("maybe use /claude-design, and /hubspot @a.ts")).toEqual([
      "/claude-design",
      "@a.ts",
    ]);
    expect(
      mentionSegments("use /codex.", skills)
        .map((s) => s.text)
        .join(""),
    ).toBe("use /codex.");
  });

  it("opens while the caret is in a leading /word", () => {
    expect(slashAt("/cla", 4)).toEqual({ query: "cla", start: 0, atStart: true });
    expect(slashAt("/", 1)).toEqual({ query: "", start: 0, atStart: true });
    expect(slashAt("/claude-design make", 19)).toBeUndefined();
    expect(slashAt("/src/app", 8)).toBeUndefined();
  });

  // A user typed "words first before /im": a skill works from anywhere in the
  // message (its note goes in front); Hermes's commands only as the whole message.
  it("and after a space mid-text, marked as not at the start (skills only)", () => {
    expect(slashAt("words first before /im", 22)).toEqual({
      query: "im",
      start: 19,
      atStart: false,
    });
    expect(slashAt("see /", 5)).toEqual({ query: "", start: 4, atStart: false });
    // A path or a URL is not a skill.
    expect(slashAt("open src/app", 12)).toBeUndefined();
    expect(slashAt("see https://x.io/do", 19)).toBeUndefined();
    expect(slashAt("a /word done", 12)).toBeUndefined();
  });
});

describe('the "@" list', () => {
  it("opens at an @ that starts a word, not in an e-mail address", () => {
    expect(mentionAt("why does @log", 13)).toEqual({ start: 9, query: "log" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("mail sam@example.com", 21)).toBeUndefined();
    expect(mentionAt("@src/auth/login.ts done", 23)).toBeUndefined();
  });

  it("ranks names that start with the query first, then contain it, then paths", () => {
    const hits = [
      "src/auth/login.ts",
      "src/auth/logout.ts",
      "src/lib/logger.ts",
      "test/auth/login.logic.test.ts",
      "docs/blog/post.md",
      "README.md",
    ].map((path) => ({ path, kind: "file" as const }));
    const all = [
      ...hits,
      ...foldersOf(hits.map((h) => h.path)).map((path) => ({ path, kind: "folder" as const })),
    ];
    // Names starting with "log" first (shorter path, then A–Z), then "blog", then a path hit.
    expect(rankPaths(all, "log").map((h) => h.path)).toEqual([
      "src/auth/login.ts",
      "src/lib/logger.ts",
      "src/auth/logout.ts",
      "test/auth/login.logic.test.ts",
      "docs/blog",
      "docs/blog/post.md",
    ]);
    expect(rankPaths(all, "auth/lo").map((h) => h.path)).toEqual([
      "src/auth/login.ts",
      "src/auth/logout.ts",
      "test/auth/login.logic.test.ts",
    ]);
    expect(rankPaths(all, "zzz")).toEqual([]);
  });

  it("offers every folder that holds a file", () => {
    expect(foldersOf(["a/b/c.ts", "a/d.ts", "e.ts"]).sort()).toEqual(["a", "a/b"]);
  });
});

describe("Hermes's commands reach the model", () => {
  it("available_commands_update fills meta.commands, cleaned", () => {
    const ops = reduceUpdate(
      emptyModel(),
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compress", description: "Compress conversation context" },
          {
            name: "model",
            description: "Switch models",
            input: { hint: "model name to switch to" },
          },
          { name: "bad name!", description: "x" },
          { name: "/queue", description: "Queue a prompt" },
          "nonsense",
        ],
      },
      { turn: 0, newId: (p) => `${p}1` },
    );
    expect(ops).toEqual([
      {
        op: "meta",
        patch: {
          commands: [
            { name: "compress", description: "Compress conversation context" },
            { name: "model", description: "Switch models", hint: "model name to switch to" },
            { name: "queue", description: "Queue a prompt" },
          ],
        },
      },
    ]);
  });
});

describe("isWebviewToHost: skills and mentions", () => {
  it("checks the skill name, the search and the mention", () => {
    expect(isWebviewToHost({ type: "send", text: "go", skills: ["humanizer", "codex"] })).toBe(
      true,
    );
    expect(isWebviewToHost({ type: "send", text: "go", skills: ['x" y'] })).toBe(false);
    expect(isWebviewToHost({ type: "send", text: "go", skills: "humanizer" })).toBe(false);
    expect(isWebviewToHost({ type: "fileSearch", query: "log", seq: 3 })).toBe(true);
    expect(isWebviewToHost({ type: "fileSearch", query: "log" })).toBe(false);
    expect(isWebviewToHost({ type: "mentionFile", path: "src/a.ts" })).toBe(true);
    expect(isWebviewToHost({ type: "mentionFile", path: "" })).toBe(false);
  });
});
