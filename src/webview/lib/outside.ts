// Close a popover when the pointer goes down anywhere outside it.

import type { Attachment } from "svelte/attachments";

/**
 * Elements marked `data-menu-trigger` do not count as outside: their own click
 * toggles the menu, and closing here first would make that click reopen it.
 */
export function outsideClick(close: () => void): Attachment<HTMLElement> {
  return (el) => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node) || el.contains(target)) return;
      if (target instanceof Element && target.closest("[data-menu-trigger]")) return;
      close();
    };
    // Capture: a click inside a child that stops propagation still counts.
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  };
}
