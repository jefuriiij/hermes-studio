import { describe, expect, it } from "vitest";

import { detectLimit } from "../src/logic/limits";
import { limitCopy } from "../src/webview/lib/format";
import { suggestModel } from "../src/webview/lib/models";

// Each reply is Hermes 0.21.5's own copy, assembled the way its source does
// (agent/turn_failure_copy.py, turn_recovery.py, conversation_loop.py).
const RATE_LIMITED =
  "Anthropic rate-limited every one of 3 attempts — its usage limit resets in ~3h. " +
  "Send /retry after that, or switch models with /model. To avoid this in future, add a " +
  "backup provider with `hermes fallback add`.\n\nProvider said: HTTP 429: rate limited" +
  "\n\nLimit resets at 14:10 (in 2h 05m).";

describe("detectLimit", () => {
  it("reads a rate limit with its provider and reset time", () => {
    expect(detectLimit(RATE_LIMITED)).toEqual({
      kind: "limit",
      provider: "Anthropic",
      resets: "14:10 (in 2h 05m)",
    });
  });

  it("falls back to 'resets in ~3h' when there is no clock time", () => {
    const text = RATE_LIMITED.replace(/\n\nLimit resets at .*$/s, "");
    expect(detectLimit(text)?.resets).toBe("in ~3h");
  });

  it("reads Codex's label and a rate limit with no reset at all", () => {
    const text =
      "ChatGPT or Codex Subscription rate-limited every one of 3 attempts — it looks " +
      "temporarily unavailable. Wait a minute and send /retry, or switch models with /model.";
    expect(detectLimit(text)).toEqual({ kind: "limit", provider: "ChatGPT or Codex Subscription" });
  });

  it("recognises an overloaded provider, a broken reply, and one that did not answer", () => {
    expect(detectLimit("Anthropic reported it was overloaded on all 3 attempts — …")?.kind).toBe(
      "overloaded",
    );
    expect(
      detectLimit(
        "ChatGPT or Codex Subscription sent back an empty or broken reply 3 times — it is…",
      )?.kind,
    ).toBe("unavailable");
    expect(detectLimit("OpenRouter didn't answer after 3 attempts — it looks…")).toEqual({
      kind: "unavailable",
      provider: "OpenRouter",
    });
  });

  it("recognises exhausted billing, naming the provider from Hermes's guidance", () => {
    const claude =
      "Billing or credits exhausted: HTTP 400: out of extra usage\n\nanthropic reported that your " +
      "Claude subscription usage is exhausted for claude-opus-5-5 (included quota + extra-usage credits).";
    expect(detectLimit(claude)).toEqual({ kind: "billing", provider: "Anthropic" });
    const unverified =
      "Provider reported usage/credit exhaustion (unverified — the same error can be a content-filter " +
      "rejection, not billing): HTTP 402";
    expect(detectLimit(unverified)).toEqual({ kind: "billing" });
  });

  it("leaves ordinary replies alone, even ones that talk about limits", () => {
    expect(
      detectLimit("Here is the fix. Note the rate-limited endpoint in api.ts."),
    ).toBeUndefined();
    expect(detectLimit("The API rate-limited every one of our test calls.")).toBeUndefined();
    expect(detectLimit("")).toBeUndefined();
  });
});

describe("limitCopy", () => {
  it("says what happened, when it lifts, and what the button does", () => {
    expect(
      limitCopy({ kind: "limit", provider: "Anthropic", resets: "14:10 (in 2h 05m)" }),
    ).toEqual({
      title: "Anthropic usage limit reached",
      body: "It resets at 14:10 (in 2h 05m). Continue on another model and your message is sent again.",
    });
    expect(limitCopy({ kind: "limit", resets: "in ~3h" }).body).toMatch(/^It resets in ~3h\. /);
    expect(limitCopy({ kind: "overloaded" }).title).toBe("The provider is overloaded right now");
    expect(limitCopy({ kind: "billing", provider: "Anthropic" }).title).toBe(
      "Anthropic: usage or credits used up",
    );
  });
});

describe("suggestModel", () => {
  const models = [
    { id: "anthropic:claude-opus-5-5", label: "claude-opus-5-5", provider: "Anthropic" },
    { id: "anthropic:claude-sonnet-5", label: "claude-sonnet-5", provider: "Anthropic" },
    {
      id: "openai-codex:gpt-6-astra",
      label: "gpt-6-astra",
      provider: "ChatGPT or Codex Subscription",
    },
  ];

  it("offers a model from another provider — a limit is per subscription", () => {
    expect(suggestModel(models, "anthropic:claude-opus-5-5", "Anthropic")?.id).toBe(
      "openai-codex:gpt-6-astra",
    );
    expect(
      suggestModel(models, "openai-codex:gpt-6-astra", "ChatGPT or Codex Subscription")?.id,
    ).toBe("anthropic:claude-opus-5-5");
  });

  it("uses the current model's provider when Hermes's label is unknown to the menu", () => {
    expect(suggestModel(models, "anthropic:claude-opus-5-5", "Mystery")?.id).toBe(
      "openai-codex:gpt-6-astra",
    );
  });

  it("offers nothing when every other model shares the provider", () => {
    expect(
      suggestModel(models.slice(0, 2), "anthropic:claude-opus-5-5", "Anthropic"),
    ).toBeUndefined();
  });
});
