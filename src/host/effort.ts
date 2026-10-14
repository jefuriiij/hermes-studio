// Hermes's reasoning effort for the modes pop-up: read with
// `hermes config get agent.reasoning_effort`, changed with
// `hermes config set --force agent.reasoning_effort <level>` — the key
// Hermes's own `/reasoning <level> --global` saves. `--force` because
// `config set` checks keys against a list that lacks this one (it prints
// "not a recognized config key", yet the agent reads it:
// hermes_constants.resolve_reasoning_config). No vscode import.

import { type EffortState, isEffortLevel, parseEffort } from "../shared/effort";
import type { RunResult } from "./accountUsage";

const KEY = "agent.reasoning_effort";

export type HermesRun = (args: readonly string[]) => Promise<RunResult>;

export class EffortService {
  private state: EffortState = { value: null, loading: false, saving: false };
  private read = false;

  constructor(
    private readonly run: () => HermesRun | undefined,
    private readonly publish: (s: EffortState) => void,
    private readonly log: (line: string) => void,
  ) {}

  get snapshot(): EffortState {
    return this.state;
  }

  /** The pop-up opened: read the setting (it may have changed in Hermes's
   *  terminal). Once at a time. */
  async refresh(): Promise<void> {
    const run = this.run();
    if (!run || this.state.loading || this.state.saving) return;
    this.update({ loading: !this.read, error: undefined });
    const r = await run(["config", "get", KEY]).catch((e: unknown) => failed(e));
    this.read = true;
    if (r.code === 0) this.update({ loading: false, value: parseEffort(r.stdout) });
    else {
      this.log(`[ext] hermes config get ${KEY}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
      this.update({ loading: false });
    }
  }

  async set(level: string): Promise<void> {
    const run = this.run();
    if (!run || !isEffortLevel(level) || this.state.saving) return;
    const before = this.state.value;
    // Show the choice at once; put it back if Hermes refuses.
    this.update({ saving: true, value: level, error: undefined });
    const r = await run(["config", "set", "--force", KEY, level]).catch((e: unknown) => failed(e));
    if (r.code === 0) {
      this.log(`[ext] effort set to ${level} (from the next new chat)`);
      this.update({ saving: false });
    } else {
      const why = firstLine(r.stderr) || `exit ${r.code}`;
      this.log(`[ext] hermes config set ${KEY} ${level}: ${why}`);
      this.update({ saving: false, value: before, error: "Hermes did not save it. See the log." });
    }
  }

  private update(patch: Partial<EffortState>): void {
    const next = { ...this.state, ...patch };
    if (next.error === undefined) delete next.error;
    this.state = next;
    this.publish(next);
  }
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";
}

function failed(e: unknown): RunResult {
  return { code: null, stdout: "", stderr: String(e) };
}
