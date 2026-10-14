// Hermes's reasoning effort (`agent.reasoning_effort` in its config.yaml), as
// the modes pop-up shows it. Pure, shared by the host and the webview.
//
// Hermes 0.21.5 has no way to change effort for one ACP session: the agent
// reads the setting when a session starts. So a change applies from the next
// new chat, and to every Hermes surface (its terminal too) — the pop-up says so.

/** The five dots, low to high; Hermes also knows minimal, ultra and none. */
export const EFFORT_LEVELS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number]["id"];

const OTHER_LABELS: Record<string, string> = {
  minimal: "Minimal",
  ultra: "Ultra",
  none: "Off",
  false: "Off",
  disabled: "Off",
};

/** Hermes uses medium when the setting is empty or unknown. */
export const EFFORT_DEFAULT: EffortLevel = "medium";

export interface EffortState {
  /** What config.yaml says; null: not set (Hermes uses medium). */
  value: string | null;
  loading: boolean;
  saving: boolean;
  error?: string;
}

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === "string" && EFFORT_LEVELS.some((l) => l.id === v);
}

/** `hermes config get agent.reasoning_effort` prints the value alone (its
 *  "not a recognized key" warning goes to stderr). */
export function parseEffort(stdout: string): string | null {
  const v = stdout.trim().split(/\r?\n/)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z]{1,16}$/.test(v) ? v : null;
}

/** "High", "Medium (default)", "Ultra". */
export function effortLabel(value: string | null): string {
  if (value === null || value === "") return "Medium (default)";
  const known = EFFORT_LEVELS.find((l) => l.id === value);
  return known?.label ?? OTHER_LABELS[value] ?? value;
}

/** How many dots are lit: 1–5; 0 for off; the nearest end for minimal/ultra. */
export function effortDots(value: string | null): number {
  const v = value || EFFORT_DEFAULT;
  const i = EFFORT_LEVELS.findIndex((l) => l.id === v);
  if (i >= 0) return i + 1;
  if (v === "minimal") return 1;
  if (v === "ultra") return 5;
  return 0;
}
