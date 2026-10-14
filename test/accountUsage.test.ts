import { describe, expect, it } from "vitest";

import { AccountUsageService, type RunResult } from "../src/host/accountUsage";
import {
  ANTHROPIC_BUG_NOTE,
  correctAnthropicUsage,
  hasAnthropicPercentBug,
  limitHitFor,
  parseAccountUsage,
  providerSlug,
  providerSlugs,
  usageCheckFor,
} from "../src/logic/accountUsage";
import type { AccountUsage } from "../src/shared/protocol";
import { isWebviewToHost } from "../src/shared/protocol";
import { lowUsage, resetLabel, slugOf, usageView } from "../src/webview/lib/usage";

// What Hermes 0.21.5 printed on a real machine (2026-09-27), trimmed.
const ANTHROPIC = JSON.stringify({
  provider: "anthropic",
  source: "oauth_usage_api",
  title: "Account limits",
  plan: null,
  fetched_at: "2026-09-27T11:13:20.042113+00:00",
  windows: [
    {
      label: "Current session",
      used_percent: 24.0,
      resets_at: "2026-09-27T13:30:00.394187+00:00",
      detail: null,
    },
    {
      label: "Current week",
      used_percent: 0.0,
      resets_at: "2026-10-04T11:00:00.394208+00:00",
      detail: null,
    },
  ],
  details: [],
  unavailable_reason: null,
});
const CODEX = JSON.stringify({
  provider: "openai-codex",
  source: "usage_api",
  plan: "Plus",
  fetched_at: "2026-09-27T11:13:23.152721+00:00",
  windows: [
    { label: "Session", used_percent: 0.0, resets_at: "2026-09-27T16:13:24+00:00", detail: null },
    { label: "Weekly", used_percent: 0.0, resets_at: "2026-10-04T04:47:16+00:00", detail: null },
  ],
  details: ["You have 1 reset banked - use /usage reset to activate"],
  unavailable_reason: null,
});

describe("parseAccountUsage", () => {
  it("reads the Anthropic OAuth windows", () => {
    expect(parseAccountUsage(ANTHROPIC)).toEqual({
      windows: [
        { label: "Current session", usedPercent: 24, resetsAt: "2026-09-27T13:30:00.394187+00:00" },
        { label: "Current week", usedPercent: 0, resetsAt: "2026-10-04T11:00:00.394208+00:00" },
      ],
      details: [],
      fetchedAt: "2026-09-27T11:13:20.042113+00:00",
    });
  });

  it("reads the Codex plan and details", () => {
    const u = parseAccountUsage(CODEX);
    expect(u?.plan).toBe("Plus");
    expect(u?.details).toEqual(["You have 1 reset banked - use /usage reset to activate"]);
    expect(u?.windows.map((w) => w.label)).toEqual(["Session", "Weekly"]);
  });

  it("gives nothing for an unavailable provider, empty output or garbage", () => {
    expect(
      parseAccountUsage(JSON.stringify({ windows: [], details: [], unavailable_reason: "no key" })),
    ).toBeUndefined();
    expect(parseAccountUsage(JSON.stringify({ windows: [], details: [] }))).toBeUndefined();
    expect(parseAccountUsage("")).toBeUndefined();
    expect(parseAccountUsage("No account usage available for provider 'x'")).toBeUndefined();
    expect(parseAccountUsage("null")).toBeUndefined();
  });

  it("clamps percentages, drops bad times and windows without a number or a text", () => {
    const u = parseAccountUsage(
      JSON.stringify({
        windows: [
          { label: "A", used_percent: 130, resets_at: "not a date" },
          { label: "B", used_percent: -4 },
          { label: "C", used_percent: null },
          { label: "Credits", used_percent: null, detail: "$3.20 left" },
          { used_percent: 50 },
        ],
        details: [7, "ok"],
      }),
    );
    expect(u?.windows).toEqual([
      { label: "A", usedPercent: 100 },
      { label: "B", usedPercent: 0 },
      { label: "Credits", detail: "$3.20 left" },
    ]);
    expect(u?.details).toEqual(["ok"]);
  });
});

describe("provider slugs", () => {
  it("is the part of a model id before the first colon", () => {
    expect(providerSlug("anthropic:claude-opus-5-5")).toBe("anthropic");
    expect(providerSlug("custom:ollama:qwen3:32b")).toBe("custom");
    expect(slugOf("openai-codex:gpt-6-astra")).toBe("openai-codex");
  });

  it("refuses anything that could read as a flag or carry a path", () => {
    expect(providerSlug("--json:x")).toBeUndefined();
    expect(providerSlug("-p:x")).toBeUndefined();
    expect(providerSlug("a b:x")).toBeUndefined();
    expect(providerSlug("../x:y")).toBeUndefined();
    expect(providerSlug(":x")).toBeUndefined();
  });

  it("lists each provider once, in order", () => {
    expect(
      providerSlugs([
        { id: "anthropic:a" },
        { id: "openai-codex:b" },
        { id: "anthropic:c" },
        { id: "--bad:d" },
      ]),
    ).toEqual(["anthropic", "openai-codex"]);
  });
});

describe("AccountUsageService", () => {
  function rig(results: Record<string, RunResult>) {
    let now = 1_000_000;
    const calls: string[] = [];
    const published: AccountUsage[] = [];
    const logs: string[] = [];
    const pending: (() => void)[] = [];
    const svc = new AccountUsageService({
      publish: (u) => published.push(u),
      log: (l) => logs.push(l),
      now: () => now,
      runner: () => (slug) => {
        calls.push(slug);
        return new Promise((resolve) =>
          pending.push(() => resolve(results[slug] ?? { code: 1, stdout: "", stderr: "none" })),
        );
      },
    });
    const settle = async () => {
      for (const p of pending.splice(0)) p();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { svc, calls, published, logs, settle, advance: (ms: number) => (now += ms) };
  }

  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });

  it("fetches each provider once, reports loading, then the results", async () => {
    const r = rig({ anthropic: ok(ANTHROPIC) });
    r.svc.refresh(["anthropic", "openrouter"]);
    expect(r.calls).toEqual(["anthropic", "openrouter"]);
    expect(r.published.at(-1)?.loading).toEqual(["anthropic", "openrouter"]);
    r.svc.refresh(["anthropic"]); // already in flight
    expect(r.calls).toHaveLength(2);
    await r.settle();
    const last = r.svc.snapshot;
    expect(last.loading).toEqual([]);
    expect(last.byProvider.anthropic?.windows[0]?.usedPercent).toBe(24);
    expect(last.byProvider.openrouter).toBeNull();
    expect(r.logs).toEqual(["[ext] hermes usage --provider openrouter: none"]);
  });

  it("keeps a result for a minute, and 'no usage' for ten", async () => {
    const r = rig({ anthropic: ok(ANTHROPIC) });
    r.svc.refresh(["anthropic", "openrouter"]);
    await r.settle();
    r.advance(30_000);
    r.svc.refresh(["anthropic", "openrouter"]);
    expect(r.calls).toHaveLength(2);
    r.advance(31_000);
    r.svc.refresh(["anthropic", "openrouter"]);
    expect(r.calls).toEqual(["anthropic", "openrouter", "anthropic"]);
    await r.settle();
    r.advance(10 * 60_000);
    r.svc.refresh(["openrouter"]);
    expect(r.calls.at(-1)).toBe("openrouter");
  });

  it("reads a fresh result again when forced (the chat just hit a limit)", async () => {
    const r = rig({ anthropic: ok(ANTHROPIC) });
    r.svc.refresh(["anthropic"]);
    await r.settle();
    r.advance(5_000);
    r.svc.refresh(["anthropic"]);
    expect(r.calls).toEqual(["anthropic"]);
    r.svc.refresh(["anthropic"], true);
    expect(r.calls).toEqual(["anthropic", "anthropic"]);
    r.svc.refresh(["anthropic"], true); // in flight: still once
    expect(r.calls).toHaveLength(2);
  });

  it("never runs a slug that is not a plain name", () => {
    const r = rig({});
    r.svc.refresh(["--json", "a b", ""]);
    expect(r.calls).toEqual([]);
    expect(r.published).toEqual([]);
  });

  it("does nothing when Hermes is not found", () => {
    const published: AccountUsage[] = [];
    const svc = new AccountUsageService({
      publish: (u) => published.push(u),
      log: () => undefined,
      now: () => 0,
      runner: () => undefined,
    });
    svc.refresh(["anthropic"]);
    expect(published).toEqual([]);
  });
});

describe("usageView (the model menu)", () => {
  const now = Date.parse("2026-09-27T11:15:00Z");
  const hm = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  it("shows the fullest window, muted while there is room", () => {
    const v = usageView(parseAccountUsage(ANTHROPIC), now, "en-GB");
    expect(v).toMatchObject({ percent: 24, text: "24% used", tone: "muted", full: false });
    expect(v?.ratio).toBeCloseTo(0.24);
    expect(v?.tooltip.split("\n")[0]).toBe(
      `Current session: 24% used, resets ${hm("2026-09-27T13:30:00.394Z")}`,
    );
  });

  it("warns from 70%, turns red from 90%, and a used-up week wins over a free session", () => {
    const at = (session: number, week: number) =>
      usageView(
        {
          windows: [
            { label: "Session", usedPercent: session, resetsAt: "2026-09-27T13:30:00Z" },
            { label: "Week", usedPercent: week, resetsAt: "2026-09-29T09:00:00Z" },
          ],
          details: [],
        },
        now,
        "en-GB",
      );
    expect(at(72, 10)?.tone).toBe("warning");
    expect(at(91, 10)?.tone).toBe("error");
    const stuck = at(5, 100);
    expect(stuck).toMatchObject({ percent: 100, full: true, tone: "error" });
    expect(stuck?.resets).toMatch(/^Tue \d\d:\d\d$/);
  });

  it("puts the plan and details in the tooltip", () => {
    const v = usageView(parseAccountUsage(CODEX), now, "en-GB");
    expect(v?.tooltip).toContain("Plan: Plus");
    expect(v?.tooltip).toContain("You have 1 reset banked");
  });

  it("falls back to the provider's text when there is no percentage", () => {
    const v = usageView(
      { windows: [{ label: "Credits", detail: "$3.20 left" }], details: [] },
      now,
    );
    expect(v).toMatchObject({ text: "$3.20 left", tone: "muted", full: false, ratio: 0 });
    expect(v?.percent).toBeUndefined();
    expect(usageView(null, now)).toBeUndefined();
  });
});

describe("resetLabel", () => {
  const now = new Date(2026, 8, 27, 11, 15).getTime(); // local Sun 27 Sep 2026, 11:15
  const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();
  it("says the clock today, 'tomorrow', a weekday, then a date", () => {
    expect(resetLabel(at(27, 14, 10), now, "en-GB")).toBe("14:10");
    expect(resetLabel(at(28, 9), now, "en-GB")).toBe("tomorrow 09:00");
    expect(resetLabel(at(30, 9), now, "en-GB")).toBe("Wed 09:00");
    expect(resetLabel(at(40, 9), now, "en-GB")).toBe("10 Oct"); // Sep has 30 days
    expect(resetLabel(undefined, now)).toBeUndefined();
  });
});

// agent/account_usage.py of Hermes 0.21.5+3169 (2026-09-26), trimmed to the
// two functions the check reads. Bug #58226: utilization is in percent points,
// but `fraction=True` multiplies a value <= 1 by 100.
const HELPER = [
  "def _usage_windows(",
  "    source: dict, mapping: tuple[tuple[str, str], ...], used_key: str, reset_key: str, *, fraction: bool = False",
  ") -> list[AccountUsageWindow]:",
  "    windows: list[AccountUsageWindow] = []",
  "    for key, label in mapping:",
  "        window = source.get(key) or {}",
  "        used = window.get(used_key)",
  "        if used is None:",
  "            continue",
  "        used = float(used)",
  "        if fraction and used <= 1:",
  "            used *= 100",
  "        windows.append(AccountUsageWindow(label=label, used_percent=used))",
  "    return windows",
  "",
].join("\n");
const ANTHROPIC_FETCH = [
  "def _fetch_anthropic_account_usage(",
  "    base_url: Optional[str] = None, api_key: Optional[str] = None",
  ") -> Optional[AccountUsageSnapshot]:",
  '    payload = _get_json("https://api.anthropic.com/api/oauth/usage", headers, timeout=15.0)',
  "    windows = _usage_windows(",
  '        payload, (("five_hour", "Current session"), ("seven_day", "Current week")),',
  '        "utilization", "resets_at", fraction=True,',
  "    )",
  '    return _snapshot("anthropic", "oauth_usage_api", windows, details)',
  "",
].join("\n");
const CODEX_FETCH = [
  "def _fetch_codex_account_usage(base_url, api_key):",
  "    windows = _usage_windows(payload, labels, 'used_percent', 'reset_at', fraction=True)",
  "",
].join("\n");

describe("hasAnthropicPercentBug (reads Hermes's own source)", () => {
  it("finds the bug in Hermes 0.21.5", () => {
    expect(hasAnthropicPercentBug(`${HELPER}\n${ANTHROPIC_FETCH}\n${CODEX_FETCH}`)).toBe(true);
  });

  it("finds the older inline form from the bug report", () => {
    const old = [
      "def _fetch_anthropic_account_usage():",
      "    used = float(util) * 100 if float(util) <= 1 else float(util)",
      "",
    ].join("\n");
    expect(hasAnthropicPercentBug(old)).toBe(true);
  });

  it("switches off when either fix lands", () => {
    // The fix proposed in #58226 / #112745: no scaling for Anthropic.
    const noFraction = ANTHROPIC_FETCH.replace("fraction=True", "fraction=False");
    expect(hasAnthropicPercentBug(`${HELPER}\n${noFraction}`)).toBe(false);
    const dropped = ANTHROPIC_FETCH.replace(", fraction=True,", ",");
    expect(hasAnthropicPercentBug(`${HELPER}\n${dropped}`)).toBe(false);
    // …or the helper stops treating 1 as a fraction.
    const helperFixed = HELPER.replace("used <= 1", "used < 1");
    expect(hasAnthropicPercentBug(`${helperFixed}\n${ANTHROPIC_FETCH}`)).toBe(false);
  });

  it("does not guess about code it does not know", () => {
    expect(hasAnthropicPercentBug("")).toBe(false);
    expect(hasAnthropicPercentBug(`${HELPER}\n${CODEX_FETCH}`)).toBe(false);
    // Only a top-level def counts, not a mention in a comment.
    expect(
      hasAnthropicPercentBug(`# see _fetch_anthropic_account_usage fraction=True\n${HELPER}`),
    ).toBe(false);
  });
});

describe("correctAnthropicUsage", () => {
  // A real account at 12:07: session 27%, week really 1% (claude.ai), Hermes says 100.
  const buggy = {
    windows: [
      { label: "Current session", usedPercent: 27, resetsAt: "2026-09-27T13:29:59Z" },
      { label: "Current week", usedPercent: 100, resetsAt: "2026-10-04T10:59:59Z" },
    ],
    details: [],
  };

  it("reads Hermes's 100 as the 1% it was", () => {
    const u = correctAnthropicUsage(buggy, false);
    expect(u.windows.map((w) => w.usedPercent)).toEqual([27, 1]);
    expect(u.details).toEqual([ANTHROPIC_BUG_NOTE]);
    expect(usageView(u, Date.parse("2026-09-27T12:10:00Z"))).toMatchObject({
      text: "27% used",
      full: false,
    });
  });

  it("trusts a 100 right after the chat hit the limit", () => {
    expect(correctAnthropicUsage(buggy, true)).toBe(buggy);
  });

  it("leaves other numbers alone", () => {
    const fine = { windows: [{ label: "Current week", usedPercent: 55 }], details: [] };
    expect(correctAnthropicUsage(fine, false)).toBe(fine);
  });
});

describe("limitHitFor", () => {
  const models = [
    { id: "anthropic:claude-opus-5-5", provider: "Anthropic" },
    { id: "openai-codex:gpt-6-astra", provider: "ChatGPT or Codex Subscription" },
  ];
  it("matches the provider Hermes named in the limit message", () => {
    const meta = {
      limit: { kind: "limit", provider: "Anthropic" },
      models,
      modelId: "openai-codex:gpt-6-astra",
    };
    expect(limitHitFor("anthropic", meta)).toBe(true);
    expect(limitHitFor("openai-codex", meta)).toBe(false);
  });
  it("falls back to the current model when the message named none", () => {
    const meta = { limit: { kind: "limit" }, models, modelId: "anthropic:claude-opus-5-5" };
    expect(limitHitFor("anthropic", meta)).toBe(true);
  });
  it("is false without a usage limit (overloaded is not one)", () => {
    expect(limitHitFor("anthropic", { models, modelId: "anthropic:claude-opus-5-5" })).toBe(false);
    expect(
      limitHitFor("anthropic", {
        limit: { kind: "overloaded" },
        models,
        modelId: "anthropic:claude-opus-5-5",
      }),
    ).toBe(false);
  });
});

describe("AccountUsageService: adjust", () => {
  it("applies the adjustment on every publish, so it follows the chat", async () => {
    let trust = false;
    const published: AccountUsage[] = [];
    const run = (): Promise<RunResult> =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          windows: [{ label: "Current week", used_percent: 100 }],
          details: [],
        }),
        stderr: "",
      });
    const svc = new AccountUsageService({
      publish: (u) => published.push(u),
      log: () => undefined,
      now: () => 0,
      runner: () => run,
      adjust: (_slug, u) => correctAnthropicUsage(u, trust),
    });
    svc.refresh(["anthropic"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(published.at(-1)?.byProvider.anthropic?.windows[0]?.usedPercent).toBe(1);
    trust = true; // the chat hit the limit; the menu opens again (cached, no fetch)
    svc.refresh(["anthropic"]);
    expect(published.at(-1)?.byProvider.anthropic?.windows[0]?.usedPercent).toBe(100);
  });
});

describe("lowUsage (the model chip)", () => {
  const now = Date.parse("2026-09-27T11:15:00Z");
  const view = (used: number) =>
    usageView(
      {
        windows: [
          { label: "Session", usedPercent: used, resetsAt: "2026-09-27T13:30:00Z" },
          { label: "Week", usedPercent: 10, resetsAt: "2026-09-29T09:00:00Z" },
        ],
        details: [],
      },
      now,
      "en-GB",
    );
  const hm = new Date("2026-09-27T13:30:00Z").toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

  it("says nothing while more than 20% is left", () => {
    expect(lowUsage(view(79))).toBeUndefined();
    expect(lowUsage(undefined)).toBeUndefined();
    expect(
      lowUsage(usageView({ windows: [{ label: "Credits", detail: "$3 left" }], details: [] }, now)),
    ).toBeUndefined();
  });

  it("amber from 20% left, red from 10% left", () => {
    expect(lowUsage(view(80))).toEqual({ text: "20% left", short: "20%", tone: "warning" });
    expect(lowUsage(view(83))).toEqual({ text: "17% left", short: "17%", tone: "warning" });
    expect(lowUsage(view(90))).toEqual({ text: "10% left", short: "10%", tone: "error" });
  });

  it("at the limit, says until when", () => {
    expect(lowUsage(view(100))).toEqual({
      text: `until ${hm}`,
      short: `until ${hm}`,
      tone: "error",
    });
  });

  it("trusts the limit banner over an older reading", () => {
    expect(lowUsage(view(40), true)).toMatchObject({ text: `until ${hm}`, tone: "error" });
    expect(lowUsage(undefined, true)).toEqual({
      text: "limit reached",
      short: "limit reached",
      tone: "error",
    });
  });
});

describe("usageCheckFor (when the chip reads usage again)", () => {
  const OPUS = "anthropic:claude-opus-5-5";
  it("reads when a reply ends", () => {
    expect(usageCheckFor({ busy: true, modelId: OPUS }, { busy: false, modelId: OPUS })).toBe(
      "anthropic",
    );
  });
  it("reads on the first model and on a switch", () => {
    expect(usageCheckFor(undefined, { busy: false, modelId: OPUS })).toBe("anthropic");
    expect(
      usageCheckFor({ busy: false, modelId: OPUS }, { busy: false, modelId: "openai-codex:gpt-6" }),
    ).toBe("openai-codex");
  });
  it("stays quiet while busy, while nothing changed, and without a model", () => {
    expect(
      usageCheckFor({ busy: false, modelId: OPUS }, { busy: true, modelId: OPUS }),
    ).toBeUndefined();
    expect(
      usageCheckFor({ busy: false, modelId: OPUS }, { busy: false, modelId: OPUS }),
    ).toBeUndefined();
    expect(usageCheckFor({ busy: true }, { busy: false })).toBeUndefined();
  });
});

describe("isWebviewToHost: refreshUsage", () => {
  it("is a bare request", () => {
    expect(isWebviewToHost({ type: "refreshUsage" })).toBe(true);
  });
});
