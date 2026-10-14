// Colours that say "how much": effort levels and edit modes (mock boards 20
// and 21), and the effort slider's snapping. Pure, and imported by relative
// path (not $shared) so the main test suite can load it. Colours are theme
// tokens (the charts palette every theme defines), with Dark Modern's values
// as the fallback.
//
// Not `charts.orange`: VS Code 1.139 derives it from the find-match highlight,
// #EA5C0055 — a third opaque, so it shows brown over the chat. Orange is mixed
// from the theme's (solid) yellow and red instead.

/** A solid orange that follows the theme. */
export const ORANGE =
  "color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 50%, var(--vscode-charts-red, #f14c4c))";

/** Low … Max: green, blue, yellow, orange, red. */
const EFFORT_TONES = [
  "var(--vscode-charts-green, #89d185)",
  "var(--vscode-charts-blue, #3794ff)",
  "var(--vscode-charts-yellow, #cca700)",
  ORANGE,
  "var(--vscode-charts-red, #f14c4c)",
] as const;

/** The colour of effort step 1–5 (clamped). */
export function effortTone(step: number): string {
  const i = Math.min(EFFORT_TONES.length, Math.max(1, Math.round(step))) - 1;
  return EFFORT_TONES[i] ?? EFFORT_TONES[1];
}

/**
 * The composer's outline and the mode chip, by edit mode: Manual keeps the
 * focus blue, Edit automatically is purple, Auto (edits any file without
 * asking) is orange. An unknown mode keeps the focus colour.
 */
export function modeTone(modeId: string | undefined): string {
  switch (modeId) {
    case "accept_edits":
      return "var(--vscode-charts-purple, #b180d7)";
    case "dont_ask":
      return ORANGE;
    default:
      return "var(--vscode-focusBorder, #0078d4)";
  }
}

/** Stops on the slider, and the positions (0–1) they sit at. */
export const STOPS = 5;
const stopPos = (step: number) => (step - 1) / (STOPS - 1);

/** The step (1–5) nearest to a position on the track. */
export function stopAt(pos: number): number {
  const p = Math.min(1, Math.max(0, pos));
  return Math.round(p * (STOPS - 1)) + 1;
}

/** Where the thumb shows while dragged: near a stop it is pulled onto it
 *  (the "magnet"), in between it follows the pointer. */
export function magnet(pos: number, pull = 0.07): number {
  const p = Math.min(1, Math.max(0, pos));
  const at = stopPos(stopAt(p));
  return Math.abs(p - at) <= pull ? at : p;
}

/** The thumb's resting position for a step. */
export function positionOf(step: number): number {
  return stopPos(Math.min(STOPS, Math.max(1, step)));
}
