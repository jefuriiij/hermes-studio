// Guards for decisions that are easy to undo by accident.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function tsFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("pure code has no `vscode` import", () => {
  // src/logic and src/shared are the tested core; hermesClient and the
  // controller are driven by the integration tests outside VS Code.
  const files = [
    ...tsFiles("src/logic"),
    ...tsFiles("src/shared"),
    "src/host/hermesClient.ts",
    "src/host/chatController.ts",
    "src/host/mutex.ts",
  ];
  for (const f of files) {
    it(f, () => {
      expect(read(f)).not.toMatch(/from\s+["']vscode["']|require\(["']vscode["']\)/);
    });
  }
});

describe("package.json manifest", () => {
  const pkg = JSON.parse(read("package.json"));
  const c = pkg.contributes;

  // The fork once registered a second (fallback) view against the same
  // provider; every post went to the hidden one and the chat showed nothing.
  it("contributes exactly one webview, the chat, in our secondary-sidebar container", () => {
    expect(c.viewsContainers.secondarySidebar).toEqual([
      { id: "hermes-studio", title: "Hermes Studio", icon: "resources/hermes.svg" },
    ]);
    expect(Object.keys(c.views)).toEqual(["hermes-studio", "hermes-studio-panels"]);
    expect(c.views["hermes-studio"]).toEqual([
      { type: "webview", id: "hermesStudio.chat", name: "Chat" },
    ]);
    const webviews = Object.values(c.views as Record<string, { type?: string }[]>)
      .flat()
      .filter((v) => v.type === "webview");
    expect(webviews).toHaveLength(1);
  });

  // Slice 5: native tree views over Hermes's files, in the activity bar.
  it("puts the Hermes panels, trees only, in their own activity-bar container", () => {
    expect(c.viewsContainers.activitybar).toEqual([
      { id: "hermes-studio-panels", title: "Hermes", icon: "resources/hermes.svg" },
    ]);
    expect(c.views["hermes-studio-panels"].map((v: { id: string }) => v.id)).toEqual([
      "hermesStudio.learning",
      "hermesStudio.curator",
      "hermesStudio.memory",
      "hermesStudio.capabilities",
      "hermesStudio.agents",
    ]);
    for (const v of c.views["hermes-studio-panels"]) expect(v.type).toBeUndefined();
  });

  // `secondarySidebar` exists from VS Code 1.106; vsce rejects @types newer than the engine.
  it("pins the engine to 1.106 and @types/vscode to the same minor", () => {
    expect(pkg.engines.vscode).toBe("^1.106.0");
    expect(pkg.devDependencies["@types/vscode"]).toMatch(/^~1\.106\./);
  });

  it("registers every command it declares", () => {
    const ext = read("src/extension.ts");
    for (const cmd of c.commands.map((x: { command: string }) => x.command)) {
      expect(ext).toContain(`registerCommand("${cmd}"`);
    }
  });

  // A workspace's .vscode/settings.json must not choose which binary we run.
  it("keeps both settings machine-scoped", () => {
    for (const [, v] of Object.entries(c.configuration.properties)) {
      expect((v as { scope?: string }).scope).toBe("machine");
    }
  });

  it("refuses untrusted workspaces", () => {
    expect(pkg.capabilities.untrustedWorkspaces.supported).toBe(false);
  });

  it("never collides with the forked extension's ids", () => {
    const text = JSON.stringify(c);
    expect(text).not.toMatch(/"hermes\.[a-zA-Z]/);
    expect(text).not.toContain('"id":"hermes"');
  });
});
