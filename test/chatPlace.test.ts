// The chat in an editor tab (mock board 15): one chat, in the side bar or in
// the tab, and the draft moves with it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { acceptedAway } from "../src/logic/chatPlace";
import { buildHtml } from "../src/logic/html";
import { isWebviewToHost } from "../src/shared/protocol";
import { takesDraft } from "../src/webview/lib/draft";

const root = join(__dirname, "..");

describe("the page the chat has left", () => {
  it("keeps its panel tabs and its way back", () => {
    for (const t of [
      "ready",
      "draft",
      "showChat",
      "moveChatHere",
      "panelOpen",
      "panelSeen",
      "refreshPanels",
    ] as const) {
      expect(acceptedAway(t)).toBe(true);
    }
  });

  it("cannot act on the chat any more", () => {
    for (const t of [
      "send",
      "cancel",
      "newChat",
      "permission",
      "openSession",
      "deleteSession",
      "setModel",
      "pasteImage",
      "dropUris",
      "compress",
    ] as const) {
      expect(acceptedAway(t)).toBe(false);
    }
  });
});

describe("the draft follows the chat", () => {
  it("fills an empty composer, and updates the copy it took", () => {
    expect(takesDraft("", undefined)).toBe(true);
    expect(takesDraft("  \n", undefined)).toBe(true);
    expect(takesDraft("fix the log", "fix the log")).toBe(true);
  });

  it("never replaces what was typed in this page since", () => {
    expect(takesDraft("my own text", undefined)).toBe(false);
    expect(takesDraft("fix the login", "fix the log")).toBe(false);
  });

  it("checks the messages", () => {
    expect(isWebviewToHost({ type: "draft", text: "" })).toBe(true);
    expect(isWebviewToHost({ type: "draft", text: "hi", skill: "git-workflows" })).toBe(true);
    expect(isWebviewToHost({ type: "draft", text: 7 })).toBe(false);
    expect(isWebviewToHost({ type: "draft", text: "x".repeat(200_001) })).toBe(false);
    expect(isWebviewToHost({ type: "draft", text: "hi", skill: "../../etc" })).toBe(false);
    expect(isWebviewToHost({ type: "showChat" })).toBe(true);
    expect(isWebviewToHost({ type: "moveChatHere" })).toBe(true);
  });
});

describe("the editor tab", () => {
  it("draws the page on the editor's background", () => {
    const html = (place?: "side" | "editor") =>
      buildHtml({ cspSource: "s", nonce: "n", scriptUri: "a.js", styleUri: "a.css", place });
    expect(html("editor")).toContain('<body data-place="editor">');
    expect(html("side")).toContain('<body data-place="side">');
    expect(html()).toContain('<body data-place="side">');
  });

  // Without the activation event, a window reload with the chat in a tab
  // finds no serializer: VS Code shows an empty tab.
  it("is restored after a window reload", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const provider = readFileSync(join(root, "src/host/chatViewProvider.ts"), "utf8");
    expect(pkg.activationEvents).toContain("onWebviewPanel:hermesStudio.chatEditor");
    expect(provider).toContain('editorType = "hermesStudio.chatEditor"');
    expect(readFileSync(join(root, "src/extension.ts"), "utf8")).toContain(
      "registerWebviewPanelSerializer(ChatViewProvider.editorType",
    );
  });

  it("has its own title-bar buttons, and the side bar a way there", () => {
    const menus = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).contributes.menus;
    const tab = "activeWebviewPanelId == 'hermesStudio.chatEditor'";
    const onTab = menus["editor/title"]
      .filter((m: { when?: string }) => m.when === tab)
      .map((m: { command: string }) => m.command);
    expect(onTab).toEqual([
      "hermesStudio.showSessions",
      "hermesStudio.newChat",
      "hermesStudio.moveChatToSidebar",
      "hermesStudio.restart",
    ]);
    expect(menus["view/title"]).toContainEqual({
      command: "hermesStudio.openChatInEditor",
      when: "view == hermesStudio.chat && !hermesStudio.chatInEditor",
      group: "navigation@2",
    });
  });
});
