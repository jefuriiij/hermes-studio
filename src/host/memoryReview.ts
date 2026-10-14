// The Memory tab's Approve / Reject (mock boards 27A/B), through Hermes's own
// handler in Hermes's own interpreter (logic/memoryReview.ts says why). One
// review at a time; only proposals of the last panels read can be named. No
// vscode import: tests drive it with a fake runner.

import {
  type HermesRuntime,
  parseReviewOutput,
  parseRuntimeCommand,
  type ReviewStep,
  reviewCommand,
} from "../logic/memoryReview";
import type { RunResult } from "./accountUsage";

export type Run = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<RunResult>;

export interface MemoryReviewDeps {
  /** The resolved Hermes launcher; undefined when Hermes is not found. */
  hermes: () => string | undefined;
  run: Run;
  /** The proposals of the last read of Hermes's files. */
  pendingIds: () => ReadonlySet<string>;
  publish: (r: { ids: string[]; ok: boolean; message?: string; unavailable?: boolean }) => void;
  /** Read Hermes's files again (the tab then shows what is left). */
  refresh: () => void;
  log: (line: string) => void;
}

const RUNTIME_MS = 20_000;
const REVIEW_MS = 30_000;

export class MemoryReview {
  private busy = false;
  private runtime?: { launcher: string; rt: HermesRuntime | null };

  constructor(private readonly deps: MemoryReviewDeps) {}

  async review(approve: string | undefined, reject: readonly string[]): Promise<void> {
    const ids = [...(approve ? [approve] : []), ...reject];
    const fail = (message: string, unavailable?: boolean) =>
      this.deps.publish({ ids, ok: false, message, ...(unavailable ? { unavailable } : {}) });
    const known = this.deps.pendingIds();
    if (ids.some((id) => !known.has(id))) {
      this.deps.refresh();
      return fail("Hermes doesn't have this change any more.");
    }
    if (this.busy) return fail("One answer at a time: try again in a moment.");
    const launcher = this.deps.hermes();
    if (!launcher) return fail("Hermes was not found.");
    this.busy = true;
    try {
      const rt = await this.runtimeFor(launcher);
      if (!rt) {
        return fail(
          "This Hermes can't be answered from here. In the Hermes CLI, run /memory pending.",
          true,
        );
      }
      const steps: ReviewStep[] = [
        ...(approve ? [{ cmd: "approve" as const, id: approve }] : []),
        ...reject.map((id) => ({ cmd: "reject" as const, id })),
      ];
      const { command, args } = reviewCommand(rt, steps);
      const r = await this.deps.run(command, args, REVIEW_MS);
      const outcome =
        r.code === 0
          ? parseReviewOutput(r.stdout, steps)
          : {
              ok: false as const,
              message: "Hermes couldn't answer it. See Hermes Studio: Show Log.",
            };
      if (outcome.ok) {
        this.deps.log(`[ext] memory: ${steps.map((s) => `${s.cmd} ${s.id}`).join(", ")}`);
        this.deps.publish({ ids, ok: true });
      } else {
        this.deps.log(
          `[ext] memory review failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-400)}`,
        );
        fail(outcome.message);
      }
    } finally {
      this.busy = false;
      this.deps.refresh();
    }
  }

  /** Hermes's interpreter set-up, asked once per launcher (a `hermes update`
   *  keeps the launcher; a failed ask is asked again next time). */
  private async runtimeFor(launcher: string): Promise<HermesRuntime | undefined> {
    if (this.runtime?.launcher === launcher && this.runtime.rt) return this.runtime.rt;
    const r = await this.deps.run(launcher, ["--print-runtime-command"], RUNTIME_MS);
    const rt = r.code === 0 ? (parseRuntimeCommand(r.stdout) ?? null) : null;
    if (!rt)
      this.deps.log(`[ext] hermes --print-runtime-command: no usable answer (exit ${r.code})`);
    this.runtime = { launcher, rt };
    return rt ?? undefined;
  }
}
