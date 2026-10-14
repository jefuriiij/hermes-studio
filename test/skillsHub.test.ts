import { describe, expect, it, vi } from "vitest";

import { type HubRun, SkillsHub } from "../src/host/skillsHub";
import {
  installArgs,
  parseHubResults,
  parseInstallOutput,
  searchArgs,
} from "../src/logic/skillsHub";
import { isWebviewToHost } from "../src/shared/protocol";

// What `hermes skills search pdf --json --limit 5` printed (0.21.5).
const SEARCH = JSON.stringify([
  {
    name: "pdf",
    identifier: "skills-sh/anthropics/skills/pdf",
    source: "skills.sh",
    trust_level: "trusted",
    description: "Indexed by skills.sh from anthropics/skills",
  },
  {
    name: "dynamic-workflow",
    identifier: "official/autonomous-ai-agents/dynamic-workflow",
    source: "official",
    trust_level: "builtin",
    description: "Plan-in-code fan-outs, adversarial verification, waves.",
  },
  {
    name: "odd",
    identifier: "skills-sh/nexu-io/open-design/pdf",
    source: "skills.sh",
    trust_level: "community",
  },
  { name: "bad", identifier: "--force", source: "github" },
  { name: "dup", identifier: "skills-sh/anthropics/skills/pdf", source: "skills.sh" },
]);

describe("Skills Hub commands", () => {
  it("searches with JSON out, and a query is never a flag", () => {
    expect(searchArgs("  pdf ", false)).toEqual([
      "skills",
      "search",
      "--json",
      "--limit",
      "30",
      "--",
      "pdf",
    ]);
    expect(searchArgs("", true)).toEqual([
      "skills",
      "search",
      "--json",
      "--limit",
      "30",
      "--source",
      "official",
      "--",
      "",
    ]);
    expect(installArgs("official/mlops/trl")).toEqual([
      "skills",
      "install",
      "--yes",
      "--",
      "official/mlops/trl",
    ]);
  });

  it("reads the results: trust, and nothing unsafe or doubled", () => {
    const items = parseHubResults(`Fetching…\n${SEARCH}`);
    expect(items?.map((s) => [s.name, s.trust])).toEqual([
      ["pdf", "trusted"],
      ["dynamic-workflow", "official"],
      ["odd", "community"],
    ]);
    expect(items?.[2]?.description).toBeUndefined();
    expect(parseHubResults("No skills found")).toBeUndefined();
  });

  it("reads what the install printed", () => {
    expect(
      parseInstallOutput(
        "Fetching: x\n\u001b[1;32mInstalled:\u001b[0m dev/x\nFiles: SKILL.md",
        "",
        0,
      ),
    ).toEqual({
      ok: true,
    });
    expect(parseInstallOutput("Warning: 'x' is already installed at …", "", 0)).toEqual({
      ok: false,
      message: "It's installed already.",
    });
    expect(
      parseInstallOutput(
        "Not installed: the security scan found 2 high-risk pattern(s) in 'x'",
        "",
        0,
      ),
    ).toEqual({
      ok: false,
      message: "Not installed: Hermes's safety check found risky code in it.",
    });
    expect(
      parseInstallOutput(
        "Error: 'x' is listed in the index, but its files no longer exist upstream.",
        "",
        0,
      ),
    ).toEqual({
      ok: false,
      message: "Not installed: 'x' is listed in the index, but its files no longer exist upstream.",
    });
    expect(parseInstallOutput("", "timed out after 180 s", null)).toEqual({
      ok: false,
      message: "Not installed: Hermes did not finish in time.",
    });
  });
});

describe("SkillsHub", () => {
  function setup(outputs: Record<string, { code: number | null; stdout: string }>) {
    const calls: string[][] = [];
    const run = vi.fn<HubRun>(async (args) => {
      calls.push([...args]);
      const r = outputs[args[1] as string] ?? { code: 1, stdout: "" };
      return { ...r, stderr: "" };
    });
    const results: unknown[] = [];
    const installed: unknown[] = [];
    const refresh = vi.fn();
    const hub = new SkillsHub({
      run: () => run,
      publishResults: (r) => results.push(r),
      publishInstalled: (r) => installed.push(r),
      refresh,
      log: () => {},
      now: () => 1000,
    });
    return { hub, calls, results, installed, refresh };
  }

  it("caches a search, and installs only what a search offered", async () => {
    const t = setup({
      search: { code: 0, stdout: SEARCH },
      install: { code: 0, stdout: "Installed: official/dynamic-workflow" },
    });
    await t.hub.install("official/autonomous-ai-agents/dynamic-workflow");
    expect(t.installed).toEqual([
      {
        identifier: "official/autonomous-ai-agents/dynamic-workflow",
        ok: false,
        message: "Search for it again first.",
      },
    ]);
    await t.hub.search("", true, 1);
    await t.hub.search("", true, 2);
    expect(t.calls.filter((c) => c[1] === "search")).toHaveLength(1);
    expect(t.results).toHaveLength(2);
    await t.hub.install("official/autonomous-ai-agents/dynamic-workflow");
    expect(t.installed[1]).toEqual({
      identifier: "official/autonomous-ai-agents/dynamic-workflow",
      ok: true,
    });
    expect(t.refresh).toHaveBeenCalled();
  });

  it("an empty search of all sources asks nothing", async () => {
    const t = setup({});
    await t.hub.search("  ", false, 3);
    expect(t.calls).toHaveLength(0);
    expect(t.results).toEqual([{ seq: 3, items: [] }]);
  });

  it("the webview may only send an identifier-shaped install", () => {
    expect(
      isWebviewToHost({ type: "hubInstall", identifier: "skills-sh/anthropics/skills/pdf" }),
    ).toBe(true);
    expect(isWebviewToHost({ type: "hubInstall", identifier: "--force" })).toBe(false);
    expect(isWebviewToHost({ type: "hubInstall", identifier: "a b" })).toBe(false);
    expect(isWebviewToHost({ type: "hubSearch", query: "pdf", official: false, seq: 1 })).toBe(
      true,
    );
    expect(
      isWebviewToHost({ type: "hubSearch", query: "x".repeat(101), official: false, seq: 1 }),
    ).toBe(false);
  });
});
