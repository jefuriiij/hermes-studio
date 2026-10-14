// Rename / delete a saved session from the Sessions pop-up, through Hermes's
// CLI (`hermes sessions rename|delete`; ACP has neither). Rules and wording
// live in logic/sessionActions.ts. No vscode import: tests drive it with a
// fake runner.

import { cleanTitle, deleteArgs, failureText, renameArgs } from "../logic/sessionActions";
import type { SessionActionResult } from "../shared/protocol";
import type { HermesRun } from "./effort";

/** What of the chat controller this needs. */
export interface SessionOwner {
  sessionChangeBlocked(sessionId: string, action: "rename" | "delete"): string | undefined;
  leaveSession(sessionId: string): Promise<void>;
  forgetSession(sessionId: string): void;
  sessionRenamed(sessionId: string, title: string): void;
  sessionTitle(sessionId: string): string | undefined;
}

export class SessionActions {
  /** One change at a time: two quick deletes must not race each other. */
  private busy = false;

  constructor(
    private readonly owner: SessionOwner,
    private readonly run: () => HermesRun | undefined,
    private readonly publish: (r: SessionActionResult) => void,
    /** Re-read the list so the pop-up shows Hermes's state. */
    private readonly refresh: () => void,
    private readonly log: (line: string) => void,
  ) {}

  async rename(sessionId: string, rawTitle: string): Promise<void> {
    const checked = cleanTitle(rawTitle);
    if (!checked.ok) return this.fail("rename", sessionId, checked.error);
    await this.change("rename", sessionId, renameArgs(sessionId, checked.title), () => {
      this.owner.sessionRenamed(sessionId, checked.title);
      return "Renamed.";
    });
  }

  async delete(sessionId: string): Promise<void> {
    const title = this.owner.sessionTitle(sessionId);
    await this.change(
      "delete",
      sessionId,
      deleteArgs(sessionId),
      () => {
        this.owner.forgetSession(sessionId);
        return title ? `Deleted “${title}”.` : "Deleted.";
      },
      // The chat on screen moves to a new chat first: Hermes would save it
      // again with its next message otherwise.
      () => this.owner.leaveSession(sessionId),
    );
  }

  private async change(
    action: "rename" | "delete",
    sessionId: string,
    args: string[],
    done: () => string,
    before?: () => Promise<void>,
  ): Promise<void> {
    const run = this.run();
    if (!run) return this.fail(action, sessionId, "Hermes was not found.");
    if (this.busy) return this.fail(action, sessionId, "One change at a time: try again.");
    const blocked = this.owner.sessionChangeBlocked(sessionId, action);
    if (blocked) return this.fail(action, sessionId, blocked);
    this.busy = true;
    try {
      await before?.();
      const r = await run(args).catch((e: unknown) => ({
        code: null,
        stdout: "",
        stderr: String(e),
      }));
      if (r.code === 0) {
        this.log(`[ext] ${action} session ${sessionId}: done`);
        this.publish({ action, sessionId, ok: true, message: done() });
      } else {
        this.log(
          `[ext] hermes ${args.slice(0, 2).join(" ")} ${sessionId}: ${(r.stdout + r.stderr).trim().slice(0, 300)}`,
        );
        this.publish({ action, sessionId, ok: false, message: failureText(r.stdout, r.stderr) });
      }
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private fail(action: "rename" | "delete", sessionId: string, message: string): void {
    this.publish({ action, sessionId, ok: false, message });
  }
}
