// The REAL `hermes usage` through the extension's runner, in the sandboxed
// home (no credentials at all, see harness.ts). Checks the facts the model
// menu relies on: a provider without usage exits 1 with nothing on stdout,
// and the service turns that into "no usage" rather than an error.
//
// Opt-in: HERMES_STUDIO_REAL=1, Windows only.

import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AccountUsageService,
  AnthropicPercentBugCheck,
  hermesUsageRunner,
  runHermes,
} from "../../src/host/accountUsage";
import { EffortService } from "../../src/host/effort";
import { hasAnthropicPercentBug } from "../../src/logic/accountUsage";
import type { AccountUsage } from "../../src/shared/protocol";
import {
  createHermesSandbox,
  type FakeModel,
  type HermesSandbox,
  RUN_REAL,
  startFakeModel,
} from "./harness";

describe.skipIf(!RUN_REAL)("hermes usage (real hermes.exe, sandboxed)", () => {
  let fake: FakeModel;
  let box: HermesSandbox;

  beforeAll(async () => {
    fake = await startFakeModel();
    box = createHermesSandbox({
      fakeModel: fake,
      parentDir: process.env.HERMES_STUDIO_REAL_TMPDIR,
    });
  }, 60_000);

  afterAll(async () => {
    box?.dispose();
    await fake?.close();
  });

  it("finds the installed Hermes's usage code and reads it (bug #58226 check)", async () => {
    const logs: string[] = [];
    const check = new AnthropicPercentBugCheck(
      () => ({ command: box.command, env: box.env }),
      (l) => logs.push(l),
    );
    await check.update();
    const file = path.join(
      path.dirname(path.dirname(box.command)),
      "hermes-agent",
      "agent",
      "account_usage.py",
    );
    const source = fs.readFileSync(file, "utf8");
    // The check targets real code: if Hermes renames the function, this fails
    // (and the correction is silently off), so we notice.
    expect(source).toMatch(/^def _fetch_anthropic_account_usage\(/m);
    expect(check.present).toBe(hasAnthropicPercentBug(source));
    console.log(`bug #58226 present in this Hermes: ${check.present}`);
  });

  it("saves the effort with `config set --force` and keeps the rest of config.yaml", async () => {
    const configFile = path.join(box.hermesHome, "config.yaml");
    const before = fs.readFileSync(configFile, "utf8");
    const svc = new EffortService(
      () => (args) => runHermes(box.command, box.env, args),
      () => undefined,
      () => undefined,
    );
    await svc.refresh();
    const first = svc.snapshot.value;
    await svc.set("xhigh");
    expect(svc.snapshot).toMatchObject({ value: "xhigh", saving: false });
    expect(svc.snapshot.error).toBeUndefined();
    await svc.refresh(); // read back from the file, not from memory
    expect(svc.snapshot.value).toBe("xhigh");
    const after = fs.readFileSync(configFile, "utf8");
    expect(after).toMatch(/reasoning_effort:\s*xhigh/);
    // The sandbox's fake model is still the configured one.
    for (const line of before.split(/\r?\n/).filter((l) => /base_url|default:/.test(l))) {
      expect(after).toContain(line.trim());
    }
    console.log(`effort before: ${first ?? "(not set)"}; after: xhigh`);
  }, 90_000);

  it("exits 1 with an empty stdout for a provider without credentials", async () => {
    const r = await hermesUsageRunner(box.command, box.env)("anthropic");
    expect(r.code).toBe(1);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toMatch(/No account usage available for provider 'anthropic'/);
  }, 60_000);

  it("the service records it as 'no usage'", async () => {
    const published: AccountUsage[] = [];
    const svc = new AccountUsageService({
      publish: (u) => published.push(u),
      log: () => undefined,
      now: () => Date.now(),
      runner: () => hermesUsageRunner(box.command, box.env),
    });
    svc.refresh(["openai-codex"]);
    const deadline = Date.now() + 50_000;
    while (svc.snapshot.loading.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(svc.snapshot).toEqual({ byProvider: { "openai-codex": null }, loading: [] });
    expect(published[0]?.loading).toEqual(["openai-codex"]);
  }, 60_000);
});
