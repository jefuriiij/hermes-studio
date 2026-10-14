// Shows a Windows notification through Windows PowerShell (logic/winToast.ts
// has the XML and the script). One process per toast, hidden, at most 15 s.

import { spawn } from "node:child_process";
import { join } from "node:path";

import {
  encodeCommand,
  TOAST_SCRIPT,
  toastTag,
  toastXml,
  type ToastContent,
} from "../logic/winToast";

const ENCODED = encodeCommand(TOAST_SCRIPT);
const TIMEOUT_MS = 15_000;

export class WindowsToasts {
  /** Windows's id for this editor's Start menu entry, once looked up. */
  private appId?: string;
  /** No Start menu entry, or PowerShell failed 3 times in a row: stop trying
   *  for this session (said once in the log). */
  private broken = false;
  private failures = 0;

  constructor(
    /** The Start menu name to look up: vscode.env.appName ("Visual Studio Code"). */
    private readonly appName: string,
    private readonly log: (line: string) => void,
  ) {}

  get available(): boolean {
    return process.platform === "win32" && !this.broken;
  }

  /** Resolves true once Windows took the toast (never rejects). */
  show(kind: string, sessionId: string, content: ToastContent): Promise<boolean> {
    if (!this.available) return Promise.resolve(false);
    return new Promise((resolve) => this.run(kind, sessionId, content, resolve));
  }

  private run(
    kind: string,
    sessionId: string,
    content: ToastContent,
    resolve: (shown: boolean) => void,
  ): void {
    const exe = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawn(
      exe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HS_TOAST_XML: toastXml(content),
          HS_TOAST_TAG: toastTag(kind, sessionId),
          HS_TOAST_APPID: this.appId ?? "",
          HS_TOAST_APPNAME: this.appName,
        },
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      this.fail(`could not start PowerShell: ${e.message}`, true);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const id = /appid=(\S*)/.exec(out)?.[1];
      if (id) this.appId = id;
      if (code === 0) this.failures = 0;
      else if (code === 3) this.fail(`no Start menu entry named "${this.appName}"`, true);
      else this.fail(`PowerShell exited with ${code}: ${err.trim().slice(0, 300)}`, false);
      resolve(code === 0);
    });
  }

  private fail(why: string, final: boolean): void {
    if (this.broken) return;
    this.log(`[ext] Windows notification failed: ${why}`);
    if (final || ++this.failures >= 3) {
      this.broken = true;
      this.log("[ext] Windows notifications are off until VS Code restarts.");
    }
  }
}
