// The effort slider's colours and snapping, and the edit modes' colours
// (mock boards 20 and 21).

import { describe, expect, it } from "vitest";

import {
  effortTone,
  magnet,
  modeTone,
  ORANGE,
  positionOf,
  stopAt,
} from "../src/webview/lib/levels";

describe("effort colours", () => {
  it("green, blue, yellow, orange, red — from the theme's charts palette", () => {
    expect([1, 2, 3, 5].map((s) => /charts-(\w+)/.exec(effortTone(s))?.[1])).toEqual([
      "green",
      "blue",
      "yellow",
      "red",
    ]);
    expect(effortTone(4)).toBe(ORANGE);
  });

  // charts.orange is the find-match highlight, a third opaque: brown on the chat.
  it("orange is solid: mixed from the theme's yellow and red, never charts.orange", () => {
    expect(ORANGE).toMatch(
      /color-mix\(in srgb, var\(--vscode-charts-yellow.*var\(--vscode-charts-red/,
    );
    for (const t of [1, 2, 3, 4, 5].map(effortTone)) expect(t).not.toContain("charts-orange");
    expect(modeTone("dont_ask")).not.toContain("charts-orange");
    expect(effortTone(0)).toBe(effortTone(1));
    expect(effortTone(9)).toBe(effortTone(5));
  });
});

describe("the slider snaps", () => {
  it("to the nearest stop", () => {
    expect([0, 0.1, 0.13, 0.49, 0.62, 0.88, 1].map(stopAt)).toEqual([1, 1, 2, 3, 3, 5, 5]);
    expect(stopAt(-1)).toBe(1);
    expect(stopAt(2)).toBe(5);
  });

  it("near a stop the thumb is pulled onto it; in between it follows", () => {
    expect(magnet(0.52)).toBe(0.5);
    expect(magnet(0.375)).toBe(0.375);
    expect(magnet(0.97)).toBe(1);
  });

  it("rests on its step", () => {
    expect([1, 2, 3, 4, 5].map(positionOf)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});

describe("edit mode colours", () => {
  it("Manual keeps the focus blue; Edit automatically purple; Auto orange", () => {
    expect(modeTone("default")).toContain("focusBorder");
    expect(modeTone("accept_edits")).toContain("charts-purple");
    expect(modeTone("dont_ask")).toBe(ORANGE);
    expect(modeTone(undefined)).toContain("focusBorder");
    expect(modeTone("something_new")).toContain("focusBorder");
  });
});
