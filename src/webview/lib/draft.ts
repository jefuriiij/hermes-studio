// The composer's text follows the chat between the side bar and the editor
// tab. Pure, and imported by relative path (not $shared) so the main test
// suite can load it.

/**
 * Whether the text the host passes on replaces what this composer holds:
 * yes when it is empty, or still holds the text it took last time (a later
 * copy of the same draft). Never over what the user typed here since.
 */
export function takesDraft(current: string, lastTaken: string | undefined): boolean {
  return current.trim() === "" || current === lastTaken;
}
