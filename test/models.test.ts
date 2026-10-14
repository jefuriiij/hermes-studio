import { describe, expect, it } from "vitest";

import { emptyModel } from "../src/shared/chat";
import { isWebviewToHost } from "../src/shared/protocol";
import {
  matchModel,
  modeChoices,
  modelChoices,
  reduceUpdate,
  sessionSettings,
} from "../src/logic/reducer";
import { modeDescription, modeIcon, modeLabel } from "../src/webview/lib/format";
import { filterModels, groupModels, stepIndex } from "../src/webview/lib/models";

// Rows as Hermes 0.21.5 builds them (acp_adapter/model_catalog.py).
const HERMES_MODELS = {
  availableModels: [
    {
      modelId: "anthropic:claude-opus-5-5",
      name: "Anthropic · claude-opus-5-5",
      description: "Provider: Anthropic • current",
    },
    {
      modelId: "anthropic:claude-sonnet-5",
      name: "Anthropic · claude-sonnet-5",
      description: "Provider: Anthropic",
    },
    {
      modelId: "openai-codex:gpt-6-astra",
      name: "ChatGPT or Codex Subscription · gpt-6-astra",
      description: "Provider: ChatGPT or Codex Subscription",
    },
    // A named custom endpoint: the name is just the model, the provider is only
    // in the description (with the model's own description after a bullet).
    {
      modelId: "custom:ollama:qwen3:32b",
      name: "qwen3:32b",
      description: "Provider: Ollama • fast local",
    },
    { modelId: "anthropic:claude-opus-5-5", name: "duplicate", description: "" },
    { name: "no id" },
  ],
  currentModelId: "anthropic:claude-opus-5-5",
};

const HERMES_MODES = {
  availableModes: [
    { id: "default", name: "Default", description: "Ask before edits." },
    { id: "accept_edits", name: "Accept Edits", description: "Auto-allow workspace edits." },
    { id: "dont_ask", name: "Don't Ask" },
  ],
  currentModeId: "default",
};

describe("modelChoices", () => {
  it("reads the model name and the provider, dropping duplicates and rows without an id", () => {
    expect(modelChoices(HERMES_MODELS)).toEqual([
      { id: "anthropic:claude-opus-5-5", label: "claude-opus-5-5", provider: "Anthropic" },
      { id: "anthropic:claude-sonnet-5", label: "claude-sonnet-5", provider: "Anthropic" },
      {
        id: "openai-codex:gpt-6-astra",
        label: "gpt-6-astra",
        provider: "ChatGPT or Codex Subscription",
      },
      { id: "custom:ollama:qwen3:32b", label: "qwen3:32b", provider: "Ollama" },
    ]);
  });

  it("copes with a missing or malformed list", () => {
    expect(modelChoices(undefined)).toEqual([]);
    expect(modelChoices({ availableModels: null })).toEqual([]);
  });
});

describe("modeChoices and sessionSettings", () => {
  it("reads the modes", () => {
    expect(modeChoices(HERMES_MODES)).toEqual([
      { id: "default", name: "Default", description: "Ask before edits." },
      { id: "accept_edits", name: "Accept Edits", description: "Auto-allow workspace edits." },
      { id: "dont_ask", name: "Don't Ask" },
    ]);
  });

  it("turns a session answer into one meta patch", () => {
    const p = sessionSettings({ models: HERMES_MODELS, modes: HERMES_MODES });
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.modelId).toBe("anthropic:claude-opus-5-5");
    expect(p.models).toHaveLength(4);
    expect(p.mode).toBe("default");
    expect(p.modes).toHaveLength(3);
  });

  it("clears (null) what an answer does not carry — undefined would not cross the bridge", () => {
    expect(sessionSettings({})).toEqual({
      model: null,
      modelId: null,
      models: null,
      mode: null,
      modes: null,
    });
    expect(sessionSettings(undefined)).toEqual({
      model: null,
      modelId: null,
      models: null,
      mode: null,
      modes: null,
    });
  });
});

describe("matchModel (a typed /model)", () => {
  const choices = modelChoices(HERMES_MODELS);

  it("finds the one choice a bare name, a full id or an id tail names", () => {
    expect(matchModel(choices, "gpt-6-astra")).toBe("openai-codex:gpt-6-astra");
    expect(matchModel(choices, "qwen3:32b")).toBe("custom:ollama:qwen3:32b");
    expect(matchModel(choices, "anthropic:claude-sonnet-5")).toBe("anthropic:claude-sonnet-5");
  });

  it("gives up when nothing or more than one matches", () => {
    expect(matchModel(choices, "llama-9")).toBeUndefined();
    const twice = [...choices, { id: "openrouter:gpt-6-astra", label: "gpt-6-astra" }];
    expect(matchModel(twice, "gpt-6-astra")).toBeUndefined();
    expect(matchModel(choices, "  ")).toBeUndefined();
  });
});

describe("reduceUpdate: current_mode_update", () => {
  it("sets the mode", () => {
    const ctx = { turn: 1, newId: (p: string) => `${p}1` };
    expect(
      reduceUpdate(
        emptyModel(),
        { sessionUpdate: "current_mode_update", currentModeId: "dont_ask" },
        ctx,
      ),
    ).toEqual([{ op: "meta", patch: { mode: "dont_ask" } }]);
    expect(reduceUpdate(emptyModel(), { sessionUpdate: "current_mode_update" }, ctx)).toEqual([]);
  });
});

describe("model menu helpers", () => {
  const choices = modelChoices(HERMES_MODELS);

  it("filters on name, id and provider, every word", () => {
    expect(filterModels(choices, "codex").map((m) => m.label)).toEqual(["gpt-6-astra"]);
    expect(filterModels(choices, "anthropic sonnet").map((m) => m.label)).toEqual([
      "claude-sonnet-5",
    ]);
    expect(filterModels(choices, "")).toHaveLength(4);
  });

  it("groups by provider in first-seen order", () => {
    expect(groupModels(choices).map((g) => [g.provider, g.items.length])).toEqual([
      ["Anthropic", 2],
      ["ChatGPT or Codex Subscription", 1],
      ["Ollama", 1],
    ]);
    expect(groupModels([{ id: "x:y", label: "y" }])[0]?.provider).toBe("Other");
  });

  it("steps through the list with wrap-around", () => {
    expect(stepIndex(-1, 1, 3)).toBe(0);
    expect(stepIndex(-1, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });

  it("names Hermes's modes like Claude's: Manual, Edit automatically, Auto", () => {
    expect(modeLabel({ id: "default", name: "Default" })).toBe("Manual");
    expect(modeLabel({ id: "accept_edits", name: "Accept Edits" })).toBe("Edit automatically");
    expect(modeLabel({ id: "dont_ask", name: "Don't Ask" })).toBe("Auto");
    expect(modeLabel(undefined)).toBe("Manual");
    expect(modeIcon({ id: "dont_ask", name: "Don't Ask" })).toBe("bolt");
  });

  it("keeps Hermes's own words for a mode it adds later", () => {
    const plan = { id: "plan", name: "Plan", description: "Read-only planning." };
    expect(modeLabel(plan)).toBe("Plan");
    expect(modeDescription(plan)).toBe("Read-only planning.");
    expect(modeIcon(plan)).toBe("shield");
  });
});

describe("isWebviewToHost: setModel / setMode", () => {
  it("accepts ids and rejects garbage", () => {
    expect(isWebviewToHost({ type: "setModel", modelId: "custom:ollama:qwen3:32b" })).toBe(true);
    expect(isWebviewToHost({ type: "setMode", modeId: "accept_edits" })).toBe(true);
    expect(isWebviewToHost({ type: "setModel" })).toBe(false);
    expect(isWebviewToHost({ type: "setModel", modelId: "" })).toBe(false);
    expect(isWebviewToHost({ type: "setMode", modeId: 3 })).toBe(false);
  });
});
