import { describe, expect, it } from "vitest";

import { envGet, isFullyQualified, resolveHermes, type ResolveInput } from "../src/logic/resolve";

const WIN_BIN = "C:\\Users\\sam\\AppData\\Local\\hermes\\bin";

function win(over: Partial<ResolveInput> & { files?: string[] } = {}): ResolveInput {
  const files = new Set((over.files ?? []).map((f) => f.toLowerCase()));
  return {
    platform: "win32",
    setting: "",
    env: {
      Path: `C:\\Windows\\system32;${WIN_BIN}`,
      LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local",
    },
    homedir: "C:\\Users\\sam",
    isFile: (p) => files.has(p.toLowerCase()),
    ...over,
  };
}

describe("resolveHermes — Windows", () => {
  it("finds hermes.exe on PATH even when the key is spelled `Path`", () => {
    const r = resolveHermes(win({ files: [`${WIN_BIN}\\hermes.exe`] }));
    expect(r).toEqual({ ok: true, command: `${WIN_BIN}\\hermes.exe`, via: "path" });
  });

  // A real install has both; spawning the .cmd without a shell throws EINVAL,
  // and with a shell, closing stdin never reaches Hermes.
  it("prefers hermes.exe and never returns hermes.cmd", () => {
    const r = resolveHermes(win({ files: [`${WIN_BIN}\\hermes.cmd`, `${WIN_BIN}\\hermes.exe`] }));
    expect(r.ok && r.command.endsWith("hermes.exe")).toBe(true);
  });

  it("reports cmd-only when PATH has hermes.cmd but no .exe anywhere", () => {
    const r = resolveHermes(win({ env: { Path: WIN_BIN }, files: [`${WIN_BIN}\\hermes.cmd`] }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("cmd-only");
  });

  it("falls back to %LOCALAPPDATA%\\hermes\\bin when PATH lacks it", () => {
    const r = resolveHermes(
      win({
        env: { Path: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" },
        files: [`${WIN_BIN}\\hermes.exe`],
      }),
    );
    expect(r).toMatchObject({ ok: true, via: "default" });
  });

  it("strips quotes and ignores relative PATH entries (no CWD hijack)", () => {
    const r = resolveHermes(
      win({
        env: { Path: `.;relative\\bin;"${WIN_BIN}"` },
        files: ["relative\\bin\\hermes.exe", `${WIN_BIN}\\hermes.exe`],
      }),
    );
    expect(r).toMatchObject({ ok: true, command: `${WIN_BIN}\\hermes.exe` });
  });

  it("uses an absolute .exe setting as-is", () => {
    const exe = "D:\\tools\\hermes.exe";
    expect(resolveHermes(win({ setting: exe, files: [exe] }))).toEqual({
      ok: true,
      command: exe,
      via: "setting",
    });
  });

  it("rejects a .cmd setting, a relative setting, and a missing file", () => {
    const cmd = resolveHermes(
      win({ setting: `${WIN_BIN}\\hermes.cmd`, files: [`${WIN_BIN}\\hermes.cmd`] }),
    );
    const rel = resolveHermes(win({ setting: "hermes.exe" }));
    const gone = resolveHermes(win({ setting: "D:\\nope\\hermes.exe" }));
    for (const r of [cmd, rel, gone]) expect(!r.ok && r.reason).toBe("setting-invalid");
  });

  it("reports missing with every path it tried", () => {
    const r = resolveHermes(win({ files: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("missing");
      expect(r.tried.length).toBeGreaterThan(1);
    }
  });
});

describe("resolveHermes — POSIX", () => {
  const posix = (files: string[], env: Record<string, string> = { PATH: "/usr/bin:/opt/h/bin" }) =>
    resolveHermes({
      platform: "linux",
      setting: "",
      env,
      homedir: "/home/j",
      isFile: (p) => files.includes(p),
    });

  it("finds hermes on PATH", () => {
    expect(posix(["/opt/h/bin/hermes"])).toEqual({
      ok: true,
      command: "/opt/h/bin/hermes",
      via: "path",
    });
  });

  it("falls back to ~/.local/bin/hermes", () => {
    expect(posix(["/home/j/.local/bin/hermes"], { PATH: "/usr/bin" })).toMatchObject({
      via: "default",
    });
  });

  // env keys are case-sensitive on POSIX: `Path` is not PATH there.
  it("does not treat `Path` as PATH off Windows", () => {
    expect(envGet({ Path: "/x" }, "PATH", "linux")).toBeUndefined();
    expect(envGet({ Path: "C:\\x" }, "PATH", "win32")).toBe("C:\\x");
  });
});

describe("fully qualified paths only (code review regression)", () => {
  // A drive-less "\tools\hermes.exe" is checked on the host's drive but spawned
  // on the workspace's drive: the file checked and the file run could differ.
  it("rejects a drive-less setting and skips drive-less PATH entries", () => {
    const rooted = "\\tools\\hermes.exe";
    const setting = resolveHermes(win({ setting: rooted, files: [rooted] }));
    expect(!setting.ok && setting.reason).toBe("setting-invalid");
    const viaPath = resolveHermes(
      win({
        env: { Path: `\\tools;${WIN_BIN}` },
        files: [rooted, `${WIN_BIN}\\hermes.exe`],
      }),
    );
    expect(viaPath).toMatchObject({ ok: true, command: `${WIN_BIN}\\hermes.exe` });
  });

  it("accepts drive-letter and UNC paths", () => {
    expect(isFullyQualified("C:\\x\\hermes.exe", "win32")).toBe(true);
    expect(isFullyQualified("\\\\server\\share\\hermes.exe", "win32")).toBe(true);
    expect(isFullyQualified("\\x\\hermes.exe", "win32")).toBe(false);
    expect(isFullyQualified("C:hermes.exe", "win32")).toBe(false);
    expect(isFullyQualified("/usr/bin/hermes", "linux")).toBe(true);
  });
});
