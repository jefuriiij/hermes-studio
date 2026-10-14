import { describe, expect, it } from "vitest";

import type { RunResult } from "../src/host/accountUsage";
import { EffortService } from "../src/host/effort";
import {
  EFFORT_LEVELS,
  type EffortState,
  effortDots,
  effortLabel,
  isEffortLevel,
  parseEffort,
} from "../src/shared/effort";

describe("effort levels", () => {
  it("offers five dots, low to max, with Hermes's ids", () => {
    expect(EFFORT_LEVELS.map((l) => l.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(isEffortLevel("xhigh")).toBe(true);
    expect(isEffortLevel("ultra")).toBe(false);
    expect(isEffortLevel(3)).toBe(false);
  });

  it("reads `hermes config get` output (the warning is on stderr)", () => {
    expect(parseEffort("high\n")).toBe("high");
    expect(parseEffort("  XHigh \r\n")).toBe("xhigh");
    expect(parseEffort("")).toBeNull();
    expect(parseEffort("{'enabled': True}")).toBeNull();
  });

  it("labels and lights the dots, with Hermes's default for an empty setting", () => {
    expect(effortLabel("high")).toBe("High");
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel(null)).toBe("Medium (default)");
    expect(effortLabel("ultra")).toBe("Ultra");
    expect(effortLabel("none")).toBe("Off");
    expect(effortDots("high")).toBe(3);
    expect(effortDots(null)).toBe(2);
    expect(effortDots("minimal")).toBe(1);
    expect(effortDots("ultra")).toBe(5);
    expect(effortDots("none")).toBe(0);
  });
});

describe("EffortService", () => {
  function rig(answers: Record<string, RunResult>) {
    const calls: string[][] = [];
    const states: EffortState[] = [];
    const logs: string[] = [];
    const svc = new EffortService(
      () => (args) => {
        calls.push([...args]);
        return Promise.resolve(answers[args[1] ?? ""] ?? { code: 1, stdout: "", stderr: "no" });
      },
      (s) => states.push(s),
      (l) => logs.push(l),
    );
    return { svc, calls, states, logs };
  }

  it("reads the setting with `config get`", async () => {
    const r = rig({ get: { code: 0, stdout: "high\n", stderr: "⚠ not a recognized config key" } });
    await r.svc.refresh();
    expect(r.calls).toEqual([["config", "get", "agent.reasoning_effort"]]);
    expect(r.states[0]).toMatchObject({ loading: true });
    expect(r.svc.snapshot).toEqual({ value: "high", loading: false, saving: false });
  });

  it("saves with `config set --force` and shows the choice at once", async () => {
    const r = rig({ set: { code: 0, stdout: "", stderr: "" } });
    await r.svc.set("xhigh");
    expect(r.calls).toEqual([["config", "set", "--force", "agent.reasoning_effort", "xhigh"]]);
    expect(r.states[0]).toMatchObject({ value: "xhigh", saving: true });
    expect(r.svc.snapshot).toEqual({ value: "xhigh", loading: false, saving: false });
  });

  it("puts the old value back when Hermes refuses", async () => {
    const r = rig({
      get: { code: 0, stdout: "high", stderr: "" },
      set: { code: 1, stdout: "", stderr: "Error: config is read-only\nmore" },
    });
    await r.svc.refresh();
    await r.svc.set("low");
    expect(r.svc.snapshot).toMatchObject({ value: "high", saving: false });
    expect(r.svc.snapshot.error).toMatch(/did not save/);
    expect(r.logs.at(-1)).toContain("Error: config is read-only");
  });

  it("never passes anything but the five levels to Hermes", async () => {
    const r = rig({});
    await r.svc.set("--help");
    await r.svc.set("ultra");
    expect(r.calls).toEqual([]);
  });
});
