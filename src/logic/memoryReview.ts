// Approve or reject a memory proposal from the Memory tab (mock boards 27A/B).
// Hermes answers these only in its CLI and gateway (`/memory approve|reject`;
// editor mode has no /memory). So the host runs the SAME function the gateway
// runs — hermes_cli/write_approval_commands.py handle_pending_subcommand with
// a fresh on-disk memory store (tools/memory_tool.py load_on_disk_store,
// written "for contexts with no live agent (gateway, Desktop, /memory)"; the
// store locks the file and re-reads it before every save) — inside Hermes's
// own interpreter set-up, which its launcher prints for tools:
// `hermes --print-runtime-command` ("Machine boundary for consumers holding
// the exact published launcher", hermes_cli/_launchers.py). Pure: no vscode,
// no child processes.

export interface ReviewStep {
  cmd: "approve" | "reject";
  id: string;
}

/** Hermes's interpreter, its flags, and its bootstrap code without the
 *  `runpy.run_module(…)` that would start the CLI. */
export interface HermesRuntime {
  command: string;
  args: string[];
  bootstrap: string;
}

/**
 * The JSON argv `--print-runtime-command` prints: [python, …flags, "-c",
 * "<bootstrap>; runpy.run_module('hermes_cli.main', …)"]. Undefined for any
 * other shape (an older or different launcher): the tab then points to the CLI.
 */
export function parseRuntimeCommand(stdout: string): HermesRuntime | undefined {
  let argv: unknown;
  try {
    argv = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!Array.isArray(argv) || argv.length < 3 || !argv.every((a) => typeof a === "string")) {
    return undefined;
  }
  const code = argv[argv.length - 1] as string;
  if (argv[argv.length - 2] !== "-c") return undefined;
  const at = code.lastIndexOf("runpy.run_module(");
  if (at <= 0) return undefined;
  const bootstrap = code.slice(0, at).replace(/[;\s]+$/, "");
  if (!bootstrap.includes("hermes_bootstrap")) return undefined;
  return { command: argv[0] as string, args: argv.slice(1, -2) as string[], bootstrap };
}

/**
 * Runs each (command, id) pair through the gateway's handler and prints the
 * answers as a JSON list. A failed approve stops the rest: "Use this one"
 * rejects the other versions only once Hermes has taken the chosen one.
 */
const SCRIPT = `
import json, sys
from hermes_cli.write_approval_commands import handle_pending_subcommand as review
from tools import write_approval as wa
from tools.memory_tool import load_on_disk_store
args, out = sys.argv[1:], []
for i in range(0, len(args) - 1, 2):
    cmd, rid = args[i], args[i + 1]
    text = review(wa.MEMORY, [cmd, rid], memory_store=load_on_disk_store() if cmd == "approve" else None) or ""
    out.append(text)
    if cmd == "approve" and not text.startswith("Approved 1 "):
        break
print(json.dumps(out))
`;

/** The command line: Hermes's interpreter, its bootstrap + our script, then
 *  the steps as plain arguments (never part of the code). */
export function reviewCommand(
  rt: HermesRuntime,
  steps: readonly ReviewStep[],
): { command: string; args: string[] } {
  return {
    command: rt.command,
    args: [...rt.args, "-c", `${rt.bootstrap}\n${SCRIPT}`, ...steps.flatMap((s) => [s.cmd, s.id])],
  };
}

export type ReviewOutcome = { ok: true } | { ok: false; message: string };

/**
 * What Hermes answered, per step (handle_pending_subcommand's wording):
 * "Approved 1 memory write(s)." (maybe with "Overwrote entire entry …"),
 * "Approved 0 … Failed: <id>: <why>", "Rejected pending memory write '<id>'.",
 * "No pending memory write with id '<id>'." A reject of a proposal that is
 * already gone counts as done: it is gone either way.
 */
export function parseReviewOutput(stdout: string, steps: readonly ReviewStep[]): ReviewOutcome {
  let answers: unknown;
  try {
    answers = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "");
  } catch {
    return { ok: false, message: "Hermes gave an answer Hermes Studio doesn't understand." };
  }
  if (!Array.isArray(answers)) {
    return { ok: false, message: "Hermes gave an answer Hermes Studio doesn't understand." };
  }
  for (const [i, step] of steps.entries()) {
    const text = typeof answers[i] === "string" ? (answers[i] as string) : undefined;
    if (text === undefined) return { ok: false, message: "Hermes stopped before it was done." };
    if (step.cmd === "approve") {
      if (text.startsWith("Approved 1 ") && !/\nFailed:/.test(text)) continue;
      return { ok: false, message: approveFailure(text) };
    }
    if (!/^Rejected pending memory write/.test(text) && !/^No pending memory write/.test(text)) {
      return { ok: false, message: firstLine(text) || "Hermes did not reject it." };
    }
  }
  return { ok: true };
}

function approveFailure(text: string): string {
  if (/^No pending memory write/.test(text)) return "Hermes doesn't have this change any more.";
  // "Failed:\n  <id>: <why>"
  const why = /\nFailed:\s*\n\s*[^:\n]+:\s*(.+)/.exec(text)?.[1]?.trim();
  if (why) return `Hermes couldn't apply it: ${why}`;
  return firstLine(text) || "Hermes couldn't apply it.";
}

const firstLine = (t: string): string => t.trim().split(/\r?\n/, 1)[0]?.slice(0, 300) ?? "";
