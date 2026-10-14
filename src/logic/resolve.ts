// Find the Hermes executable. Pure: every input is passed in, so the Windows
// and POSIX rules are both testable on any machine.
//
// Why this is not just `spawn("hermes")`:
//   - We must spawn with shell:false. With a shell in the chain, closing our
//     stdin never reaches Hermes, and graceful shutdown silently stops working
//     (found the hard way in Synthra's extension).
//   - Node refuses to spawn a `.cmd` without a shell (EINVAL, CVE-2024-27980),
//     and a Hermes install on Windows has both hermes.cmd and hermes.exe.
//   - A VS Code started from the Start menu may not have Git's `which`, which
//     is what the forked extension relied on — so we walk PATH ourselves.
//   - We want an absolute path in the log, so "which binary ran" is never a
//     guess.

import * as path from "node:path";

export interface ResolveInput {
  platform: string;
  /** The hermesStudio.path setting; "" when unset. */
  setting: string;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
  /** True when a regular file exists at this path. */
  isFile(p: string): boolean;
}

export type Resolution =
  | { ok: true; command: string; via: "setting" | "path" | "default" }
  | {
      ok: false;
      reason: "setting-invalid" | "cmd-only" | "missing";
      message: string;
      tried: string[];
    };

/** Read an env var the way the OS does: case-insensitively on Windows, where
 *  process.env commonly carries `Path`, not `PATH`. */
export function envGet(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: string,
): string | undefined {
  if (platform !== "win32") return env[name];
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === want) return v;
  return undefined;
}

/**
 * A path that names one file no matter the current directory or drive.
 * path.win32.isAbsolute also accepts drive-less rooted paths ("\tools\x.exe"):
 * the existence check resolves those against the extension host's drive, but
 * spawn resolves them against the drive of its cwd (the workspace) — so the
 * file we checked and the file that runs could differ. Windows requires a
 * drive letter or a UNC path.
 */
export function isFullyQualified(p: string, platform: string): boolean {
  if (platform !== "win32") return path.posix.isAbsolute(p);
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(p);
}

export function resolveHermes(input: ResolveInput): Resolution {
  const win = input.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const exeName = win ? "hermes.exe" : "hermes";
  const tried: string[] = [];

  const setting = input.setting.trim();
  if (setting) {
    tried.push(setting);
    if (!isFullyQualified(setting, input.platform)) {
      return fail(
        "setting-invalid",
        win
          ? `hermesStudio.path must be a full path with a drive letter, e.g. C:\\…\\hermes.exe (got "${setting}").`
          : `hermesStudio.path must be an absolute path (got "${setting}").`,
        tried,
      );
    }
    if (win && /\.(cmd|bat)$/i.test(setting)) {
      return fail(
        "setting-invalid",
        `hermesStudio.path points at a ${p.extname(setting)} script. Point it at hermes.exe instead — a script can only run through a shell, which breaks clean shutdown.`,
        tried,
      );
    }
    if (!input.isFile(setting)) {
      return fail("setting-invalid", `hermesStudio.path: no file at "${setting}".`, tried);
    }
    return { ok: true, command: setting, via: "setting" };
  }

  let sawCmd = false;
  const pathVar = envGet(input.env, "PATH", input.platform) ?? "";
  for (const raw of pathVar.split(win ? ";" : ":")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    // Skip "", relative and drive-less entries: all of them resolve against
    // some current directory, which a workspace can control (CWD hijack).
    if (!dir || !isFullyQualified(dir, input.platform)) continue;
    const candidate = p.join(dir, exeName);
    tried.push(candidate);
    if (input.isFile(candidate)) return { ok: true, command: candidate, via: "path" };
    if (win && input.isFile(p.join(dir, "hermes.cmd"))) sawCmd = true;
  }

  const defaults: string[] = [];
  if (win) {
    const local = envGet(input.env, "LOCALAPPDATA", input.platform);
    if (local) defaults.push(p.join(local, "hermes", "bin", "hermes.exe"));
  } else {
    defaults.push(p.join(input.homedir, ".local", "bin", "hermes"));
  }
  for (const d of defaults) {
    tried.push(d);
    if (input.isFile(d)) return { ok: true, command: d, via: "default" };
  }

  if (sawCmd) {
    return fail(
      "cmd-only",
      "Found hermes.cmd but no hermes.exe on PATH. Set hermesStudio.path to the absolute path of hermes.exe.",
      tried,
    );
  }
  return fail(
    "missing",
    "Hermes was not found. Install Hermes Agent, or set hermesStudio.path to the absolute path of the hermes executable.",
    tried,
  );
}

function fail(
  reason: "setting-invalid" | "cmd-only" | "missing",
  message: string,
  tried: string[],
) {
  return { ok: false as const, reason, message, tried };
}
