// The environment Hermes is started with.
//
// Hermes hands its own environment to every command its terminal tool runs, so
// anything we pass it, the agent's commands inherit. The extension host carries
// variables that only make sense inside VS Code:
//   - ELECTRON_RUN_AS_NODE=1 makes any Electron binary run as plain Node. An
//     agent running an extension test suite (@vscode/test-electron), `code`, or
//     an Electron app's dev server would fail in confusing ways.
//   - VSCODE_* point at this extension host's IPC handles and PIDs.
// VS Code strips the same set before starting its own terminals and tasks.

const DROP_EXACT = new Set(["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE"]);

function dropped(key: string): boolean {
  const k = key.toUpperCase();
  return DROP_EXACT.has(k) || k.startsWith("VSCODE_");
}

/**
 * Copy `base` without the host-only variables, then layer `overrides` on top.
 * Key casing is preserved (Windows' `Path` stays `Path` — re-casing it can leave
 * two PATH keys, and which one a child sees is then undefined).
 */
export function buildChildEnv(
  base: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !dropped(k)) env[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    // An override replaces a same-named key regardless of case, so a test's
    // HERMES_HOME wins over an inherited `Hermes_Home` on Windows.
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === k.toUpperCase()) delete env[existing];
    }
    if (v !== undefined) env[k] = v;
  }
  return env;
}
