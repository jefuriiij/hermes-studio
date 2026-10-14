// The Memory tab's Approve / Reject and the Capabilities tab's "Get more"
// against the REAL Hermes, in the sandboxed home (see harness.ts): proposals
// are staged with Hermes's own stage_write, answered through the extension's
// route (Hermes's interpreter + the gateway's handler), and a skill is
// searched and installed into the sandbox's own skills folder.
//
// Opt-in: HERMES_STUDIO_REAL=1, Windows only.

import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runHermes } from "../../src/host/accountUsage";
import { MemoryReview } from "../../src/host/memoryReview";
import { SkillsHub } from "../../src/host/skillsHub";
import { parseRuntimeCommand } from "../../src/logic/memoryReview";
import type { HubSkill } from "../../src/shared/panels";
import {
  createHermesSandbox,
  type FakeModel,
  type HermesSandbox,
  RUN_REAL,
  startFakeModel,
} from "./harness";

const OLD = "Sam wants one design language in UI: no pills.";

describe.skipIf(!RUN_REAL)("panel actions (real hermes.exe, sandboxed)", () => {
  let fake: FakeModel;
  let box: HermesSandbox;
  const mem = (f: string) => path.join(box.hermesHome, "memories", f);

  beforeAll(async () => {
    fake = await startFakeModel();
    box = createHermesSandbox({
      fakeModel: fake,
      parentDir: process.env.HERMES_STUDIO_REAL_TMPDIR,
    });
    // The sandbox turns memory off for its chats; approving needs it on.
    const config = path.join(box.hermesHome, "config.yaml");
    fs.writeFileSync(
      config,
      fs
        .readFileSync(config, "utf8")
        .replace(/(memory_enabled|user_profile_enabled): false/g, "$1: true"),
    );
    fs.mkdirSync(path.join(box.hermesHome, "memories"), { recursive: true });
    fs.writeFileSync(mem("MEMORY.md"), "Uses pnpm.");
    fs.writeFileSync(mem("USER.md"), `Senior developer.\n§\n${OLD}`);
  }, 60_000);

  afterAll(async () => {
    box?.dispose();
    await fake?.close();
  });

  /** Stage proposals the way Hermes's memory tool does (tools/write_approval.py). */
  async function stage(): Promise<[string, string, string]> {
    const printed = await runHermes(box.command, box.env, ["--print-runtime-command"], 30_000);
    const rt = parseRuntimeCommand(printed.stdout);
    if (!rt) throw new Error(`no runtime: ${printed.stderr}`);
    const code = `${rt.bootstrap}
import json
from tools import write_approval as wa
ids = [wa.stage_write("memory", {"action": "add", "target": "memory", "content": "Staging moved to staging.example.com."}, summary="add", origin="foreground")["id"]]
for c in ["Version one.", "Version two."]:
    ids.append(wa.stage_write("memory", {"action": "replace", "target": "user", "old_text": "Sam wants one", "content": c, "matched_entry": ${JSON.stringify(OLD)}}, summary="replace", origin="background_review")["id"])
print(json.dumps(ids))
`;
    const r = await runHermes(rt.command, box.env, [...rt.args, "-c", code], 30_000);
    let ids: unknown;
    try {
      ids = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "");
    } catch {
      ids = undefined;
    }
    if (!Array.isArray(ids) || ids.length !== 3) {
      throw new Error(`staging failed (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
    }
    return ids as [string, string, string];
  }

  it("approves one version, rejects the other, and adds a note — as /memory would", async () => {
    const [add, v1, v2] = await stage();
    const pending = new Set([add, v1, v2]);
    const published: { ids: string[]; ok: boolean; message?: string }[] = [];
    const review = new MemoryReview({
      hermes: () => box.command,
      run: (command, args, ms) => runHermes(command, box.env, args, ms),
      pendingIds: () => pending,
      publish: (r) => published.push(r),
      refresh: () => undefined,
      log: (l) => console.log(l),
    });

    await review.review(v2, [v1]); // "Use this one" on version two
    await review.review(add, []);
    await review.review(v1, []); // already answered: Hermes says so
    expect(published[0]).toEqual({ ids: [v2, v1], ok: true });
    expect(published[1]).toEqual({ ids: [add], ok: true });
    expect(published[2]).toMatchObject({
      ok: false,
      message: "Hermes doesn't have this change any more.",
    });

    const user = fs.readFileSync(mem("USER.md"), "utf8");
    expect(user).toContain("Version two.");
    expect(user).not.toContain(OLD);
    expect(user).not.toContain("Version one.");
    expect(fs.readFileSync(mem("MEMORY.md"), "utf8")).toContain(
      "Staging moved to staging.example.com.",
    );
    expect(fs.readdirSync(path.join(box.hermesHome, "pending", "memory"))).toEqual([]);
  }, 120_000);

  it("searches the Skills Hub and installs an official skill into the sandbox", async () => {
    const results: { items: HubSkill[]; error?: string }[] = [];
    const installed: { ok: boolean; message?: string }[] = [];
    const env = { ...box.env, NO_COLOR: "1", TERM: "dumb", COLUMNS: "200" };
    const hub = new SkillsHub({
      run: () => (args, ms) => runHermes(box.command, env, args, ms),
      publishResults: (r) => results.push(r),
      publishInstalled: (r) => installed.push(r),
      refresh: () => undefined,
      log: (l) => console.log(l),
      now: () => Date.now(),
    });
    await hub.search("", true, 1);
    const official = results[0]?.items ?? [];
    console.log(`official skills: ${official.length}; error: ${results[0]?.error ?? "none"}`);
    expect(official.length).toBeGreaterThan(0);
    expect(official.every((s) => s.trust === "official")).toBe(true);
    const pick = official.find((s) => s.name === "dynamic-workflow") ?? official[0];
    if (!pick) throw new Error("no official skill");
    await hub.install(pick.identifier);
    console.log(`install ${pick.identifier}: ${JSON.stringify(installed[0])}`);
    expect(installed[0]).toEqual({ identifier: pick.identifier, ok: true });
    const lock = fs.readFileSync(path.join(box.hermesHome, "skills", ".hub", "lock.json"), "utf8");
    expect(lock).toContain(pick.name);
    // A second install: Hermes says it's there (we never --force).
    await hub.install(pick.identifier);
    expect(installed[1]).toMatchObject({ ok: false, message: "It's installed already." });
  }, 240_000);
});
