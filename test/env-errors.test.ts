import { describe, expect, it } from "vitest";

import { buildChildEnv } from "../src/logic/env";
import { errorText, isSetupNeeded, sleep, TimeoutError, withTimeout } from "../src/logic/errors";

describe("buildChildEnv", () => {
  // Hermes passes its env to every command the agent runs. ELECTRON_RUN_AS_NODE
  // would make any Electron app the agent launches run as plain Node.
  it("drops the extension host's own variables", () => {
    const env = buildChildEnv({
      Path: "C:\\Windows",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      VSCODE_IPC_HOOK: "\\\\.\\pipe\\x",
      vscode_pid: "123",
      HOME: "C:\\Users\\sam",
    });
    expect(env).toEqual({ Path: "C:\\Windows", HOME: "C:\\Users\\sam" });
  });

  it("keeps key casing and lets an override replace a key of any case", () => {
    const env = buildChildEnv({ Path: "a", Hermes_Home: "real" }, { HERMES_HOME: "temp" });
    expect(env).toEqual({ Path: "a", HERMES_HOME: "temp" });
  });

  it("removes a key when the override is undefined", () => {
    expect(buildChildEnv({ OPENAI_API_KEY: "sk" }, { OPENAI_API_KEY: undefined })).toEqual({});
  });
});

describe("errors", () => {
  // Hermes wraps agent failures as -32603 with the real reason in data.details.
  it("prefers data.details over the generic JSON-RPC message", () => {
    const e = { code: -32603, message: "Internal error", data: { details: "save_session failed" } };
    expect(errorText(e)).toBe("save_session failed");
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  it("recognizes Hermes's no-provider error", () => {
    const e = {
      code: -32603,
      message: "Internal error",
      data: {
        details:
          "No LLM provider configured. Run `hermes model` to select a provider, or run `hermes setup` for first-time configuration.",
      },
    };
    expect(isSetupNeeded(e)).toBe(true);
    expect(isSetupNeeded({ message: "ECONNRESET" })).toBe(false);
  });

  it("times out with a readable message, and passes a fast result through", async () => {
    await expect(withTimeout(sleep(50), 5, "session/new")).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
  });
});
