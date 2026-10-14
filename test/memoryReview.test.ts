import { describe, expect, it, vi } from "vitest";

import { MemoryReview, type Run } from "../src/host/memoryReview";
import { parseReviewOutput, parseRuntimeCommand, reviewCommand } from "../src/logic/memoryReview";
import { isWebviewToHost } from "../src/shared/protocol";

// What `hermes --print-runtime-command` printed on the Windows install (0.21.5).
const PRINTED = JSON.stringify([
  "C:\\Users\\me\\AppData\\Local\\hermes\\tools\\python-3.14.7+20260901-win32-x64\\python.exe",
  "-I",
  "-c",
  "import os, sys, runpy; os.environ.pop('PYTHONHOME', None); os.environ.pop('PYTHONPATH', None); os.environ.pop('VIRTUAL_ENV', None); sys.path.insert(0, 'C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\hermes\\\\hermes-agent'); os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or str(__import__('hermes_constants').get_default_hermes_root()); import hermes_bootstrap; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)",
]);

describe("Hermes's interpreter set-up", () => {
  it("keeps the interpreter, its flags and the bootstrap, not the CLI start", () => {
    const rt = parseRuntimeCommand(`${PRINTED}\n`);
    expect(rt?.command).toMatch(/python\.exe$/);
    expect(rt?.args).toEqual(["-I"]);
    expect(rt?.bootstrap.endsWith("import hermes_bootstrap")).toBe(true);
    expect(rt?.bootstrap).not.toContain("run_module");
  });

  it("refuses any other shape", () => {
    expect(parseRuntimeCommand("usage: hermes …")).toBeUndefined();
    expect(
      parseRuntimeCommand(JSON.stringify(["python", "-m", "hermes_cli.main"])),
    ).toBeUndefined();
    expect(parseRuntimeCommand(JSON.stringify(["python", "-c", "print(1)"]))).toBeUndefined();
    expect(parseRuntimeCommand(JSON.stringify(["python", "-c", 5]))).toBeUndefined();
  });

  it("passes the steps as arguments, never inside the code", () => {
    const rt = parseRuntimeCommand(PRINTED);
    if (!rt) throw new Error("no runtime");
    const { command, args } = reviewCommand(rt, [
      { cmd: "approve", id: "b1be67ac" },
      { cmd: "reject", id: "c9385bd7" },
    ]);
    expect(command).toBe(rt.command);
    expect(args.slice(0, 2)).toEqual(["-I", "-c"]);
    expect(args[2]).toContain("handle_pending_subcommand");
    expect(args[2]).toContain("load_on_disk_store");
    expect(args[2]).not.toContain("b1be67ac");
    expect(args.slice(3)).toEqual(["approve", "b1be67ac", "reject", "c9385bd7"]);
  });
});

describe("Hermes's answers", () => {
  const approve = [{ cmd: "approve" as const, id: "a1" }];
  it("an approve worked, even when it overwrote an entry", () => {
    expect(parseReviewOutput(JSON.stringify(["Approved 1 memory write(s)."]), approve)).toEqual({
      ok: true,
    });
    const overwrote =
      "Approved 1 memory write(s).\nOverwrote entire entry (re-add anything you still need):\n  a1: old";
    expect(parseReviewOutput(JSON.stringify([overwrote]), approve)).toEqual({ ok: true });
  });

  it("says why an approve failed", () => {
    const failed =
      "Approved 0 memory write(s).\nFailed:\n  a1: the entry this change was reviewed against is gone";
    expect(parseReviewOutput(JSON.stringify([failed]), approve)).toEqual({
      ok: false,
      message: "Hermes couldn't apply it: the entry this change was reviewed against is gone",
    });
    expect(
      parseReviewOutput(JSON.stringify(["No pending memory write with id 'a1'."]), approve),
    ).toEqual({
      ok: false,
      message: "Hermes doesn't have this change any more.",
    });
  });

  it("a reject of one already gone is done; a stop before the end is not", () => {
    const steps = [
      { cmd: "approve" as const, id: "a1" },
      { cmd: "reject" as const, id: "b2" },
      { cmd: "reject" as const, id: "c3" },
    ];
    const all = [
      "Approved 1 memory write(s).",
      "Rejected pending memory write 'b2'.",
      "No pending memory write with id 'c3'.",
    ];
    expect(parseReviewOutput(`bootstrap noise\n${JSON.stringify(all)}`, steps)).toEqual({
      ok: true,
    });
    expect(parseReviewOutput(JSON.stringify(all.slice(0, 1)), steps)).toEqual({
      ok: false,
      message: "Hermes stopped before it was done.",
    });
    expect(parseReviewOutput("Traceback …", steps).ok).toBe(false);
  });
});

describe("MemoryReview", () => {
  function setup(
    runs: Array<{ code: number | null; stdout: string }>,
    pending = ["a1", "b2", "c3"],
  ) {
    const calls: string[][] = [];
    const run = vi.fn<Run>(async (command, args) => {
      calls.push([command, ...args]);
      const r = runs.shift() ?? { code: 1, stdout: "" };
      return { ...r, stderr: "" };
    });
    const published: unknown[] = [];
    const refresh = vi.fn();
    const review = new MemoryReview({
      hermes: () => "C:/h/bin/hermes.exe",
      run,
      pendingIds: () => new Set(pending),
      publish: (r) => published.push(r),
      refresh,
      log: () => {},
    });
    return { review, calls, published, refresh };
  }

  it("asks for the set-up once, then answers with Hermes's handler", async () => {
    const t = setup([
      { code: 0, stdout: PRINTED },
      {
        code: 0,
        stdout: JSON.stringify([
          "Approved 1 memory write(s).",
          "Rejected pending memory write 'b2'.",
        ]),
      },
      { code: 0, stdout: JSON.stringify(["Rejected pending memory write 'c3'."]) },
    ]);
    await t.review.review("a1", ["b2"]);
    await t.review.review(undefined, ["c3"]);
    expect(t.calls[0]).toEqual(["C:/h/bin/hermes.exe", "--print-runtime-command"]);
    expect(t.calls[1]?.slice(-4)).toEqual(["approve", "a1", "reject", "b2"]);
    expect(t.calls[2]?.slice(-2)).toEqual(["reject", "c3"]);
    expect(t.calls).toHaveLength(3);
    expect(t.published).toEqual([
      { ids: ["a1", "b2"], ok: true },
      { ids: ["c3"], ok: true },
    ]);
    expect(t.refresh).toHaveBeenCalledTimes(2);
  });

  it("answers only proposals of the last read", async () => {
    const t = setup([]);
    await t.review.review("zz", []);
    expect(t.calls).toHaveLength(0);
    expect(t.published).toEqual([
      { ids: ["zz"], ok: false, message: "Hermes doesn't have this change any more." },
    ]);
    expect(t.refresh).toHaveBeenCalled();
  });

  it("an unknown launcher shape points to the CLI", async () => {
    const t = setup([{ code: 2, stdout: "" }]);
    await t.review.review("a1", []);
    expect(t.published[0]).toMatchObject({ ok: false, unavailable: true });
  });

  it("the webview may only name proposal ids", () => {
    expect(
      isWebviewToHost({ type: "memoryReview", approve: "b1be67ac", reject: ["c9385bd7"] }),
    ).toBe(true);
    expect(isWebviewToHost({ type: "memoryReview", reject: ["c9385bd7"] })).toBe(true);
    expect(isWebviewToHost({ type: "memoryReview", reject: [] })).toBe(false);
    expect(isWebviewToHost({ type: "memoryReview", approve: "a1", reject: ["a1"] })).toBe(false);
    expect(isWebviewToHost({ type: "memoryReview", approve: "--all", reject: [] })).toBe(false);
    // Hermes reads "all" as every proposal.
    expect(isWebviewToHost({ type: "memoryReview", approve: "all", reject: [] })).toBe(false);
    expect(isWebviewToHost({ type: "memoryReview", reject: ["ALL"] })).toBe(false);
    expect(isWebviewToHost({ type: "memoryReview", reject: ["a b"] })).toBe(false);
  });
});
