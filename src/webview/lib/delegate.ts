// Delegated handlers for the sanitized markdown HTML. That HTML is injected
// with {@html} and may be replaced on every streamed batch, so it carries no
// listeners of its own: one listener on the message list handles every link
// and every Copy button, present or future.

import type { Attachment } from "svelte/attachments";

const FLASH_MS = 1500;
const timers = new WeakMap<HTMLElement, number>();

function flash(button: HTMLElement, label: string, state: "done" | "failed"): void {
  const prev = timers.get(button);
  if (prev !== undefined) clearTimeout(prev);
  button.textContent = label;
  button.dataset.state = state;
  timers.set(
    button,
    window.setTimeout(() => {
      button.textContent = "Copy";
      delete button.dataset.state;
      timers.delete(button);
    }, FLASH_MS),
  );
}

/** execCommand("copy") on a selection: only reached if the async clipboard API
 *  is refused (it should not be in a VS Code webview, which grants
 *  clipboard-write). */
function legacyCopy(node: Node): boolean {
  const sel = window.getSelection();
  if (!sel) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  sel.removeAllRanges();
  sel.addRange(range);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    sel.removeAllRanges();
  }
}

/** Copy plain text (a whole reply, as Hermes wrote it): true when it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const holder = document.createElement("pre");
    holder.textContent = text;
    holder.style.position = "fixed";
    holder.style.opacity = "0";
    document.body.append(holder);
    const ok = legacyCopy(holder);
    holder.remove();
    return ok;
  }
}

async function copyCode(button: HTMLElement): Promise<void> {
  const code = button.closest(".code-block")?.querySelector("code");
  if (!code) return;
  // textContent of the highlighted HTML is exactly the original source.
  const text = code.textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
    flash(button, "Copied", "done");
  } catch {
    const ok = legacyCopy(code);
    flash(button, ok ? "Copied" : "Copy failed", ok ? "done" : "failed");
  }
}

/** Attach to the element that contains rendered markdown. */
export function markdownActions(
  openLink: (href: string) => void,
  openFile?: (path: string, line?: number) => void,
): Attachment<HTMLElement> {
  return (root) => {
    const linkOf = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      const a = target.closest<HTMLElement>("[data-href]");
      return a && root.contains(a) ? a : null;
    };
    // A path the host said is a real file (Markdown.svelte adds is-file).
    const fileOf = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      const c = target.closest<HTMLElement>("code.md-path.is-file");
      return c && root.contains(c) ? c : null;
    };
    const open = (c: HTMLElement) => {
      const line = Number(c.dataset.line);
      openFile?.(c.dataset.path ?? "", Number.isInteger(line) && line > 0 ? line : undefined);
    };

    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      const copy = e.target.closest<HTMLElement>("button.code-copy");
      if (copy && root.contains(copy)) {
        e.preventDefault();
        void copyCode(copy);
        return;
      }
      const file = fileOf(e.target);
      if (file && openFile) {
        e.preventDefault();
        open(file);
        return;
      }
      const a = linkOf(e.target);
      if (a) {
        e.preventDefault();
        openLink(a.dataset.href ?? "");
      }
    };

    // role="link" promises Enter activates it, as it would a real <a href>.
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const file = fileOf(e.target);
      if (file && file === e.target && openFile) {
        e.preventDefault();
        open(file);
        return;
      }
      const a = linkOf(e.target);
      if (a && a === e.target) {
        e.preventDefault();
        openLink(a.dataset.href ?? "");
      }
    };

    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeydown);
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeydown);
    };
  };
}
