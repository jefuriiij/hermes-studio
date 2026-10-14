// The model menu's list: Hermes's picker rows, filtered by the search box and
// grouped by provider in Hermes's own order. Pure: no DOM, no Svelte, and
// imported by relative path (not $shared) so the main test suite can load it.

import type { ModelChoice } from "../../shared/chat";

export interface ModelGroup {
  provider: string;
  items: ModelChoice[];
}

const OTHER = "Other";

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Every word of the query must appear in the model name, id or provider. */
export function filterModels(models: readonly ModelChoice[], query: string): ModelChoice[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...models];
  return models.filter((m) => {
    const hay = fold(`${m.label} ${m.id} ${m.provider ?? ""}`);
    return words.every((w) => hay.includes(w));
  });
}

/** Groups in the order their first model appears (Hermes lists the
 *  authenticated providers in its canonical order). */
export function groupModels(models: readonly ModelChoice[]): ModelGroup[] {
  const groups = new Map<string, ModelChoice[]>();
  for (const m of models) {
    const key = m.provider || OTHER;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  return [...groups].map(([provider, items]) => ({ provider, items }));
}

/**
 * The model to offer after a limit: the first one from ANOTHER provider (a
 * limit is per subscription, so another Claude model would hit the same
 * wall). Hermes lists providers in its canonical order.
 */
export function suggestModel(
  models: readonly ModelChoice[],
  currentId: string | undefined,
  limitedProvider?: string,
): ModelChoice | undefined {
  const current = models.find((m) => m.id === currentId);
  // Hermes names the provider in its message; trust it only if the menu knows it.
  const blocked = models.some((m) => m.provider === limitedProvider)
    ? limitedProvider
    : current?.provider;
  return models.find(
    (m) => m.id !== currentId && (blocked === undefined || m.provider !== blocked),
  );
}

/** Arrow-key movement through a flat list, wrapping at both ends. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (((current + delta) % length) + length) % length;
}
