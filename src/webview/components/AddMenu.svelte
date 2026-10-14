<script lang="ts">
  import type { ContextChip } from "$shared/protocol";
  import { chat } from "$lib/chat.svelte";
  import { stepIndex } from "$lib/models";
  import { outsideClick } from "$lib/outside";
  import ContextIcon from "./ContextIcon.svelte";

  let { onclose }: { onclose: (why: "pick" | "escape" | "outside") => void } = $props();

  type Kind = ContextChip["kind"];
  const ENTRIES: { kind: Kind; label: string; hint: string }[] = [
    { kind: "file", label: "Files", hint: "search the workspace" },
    { kind: "image", label: "Image", hint: "upload or paste" },
    { kind: "selection", label: "Selection", hint: "from the editor" },
    { kind: "problems", label: "Problems", hint: "errors and warnings" },
    { kind: "git", label: "Git changes", hint: "not committed yet" },
  ];
  const images = $derived(chat.context.images);
  const entries = $derived(ENTRIES.filter((e) => e.kind !== "image" || images));
  let items: HTMLElement[] = $state([]);

  function pick(kind: Kind): void {
    // The host shows a picker (files, image) or adds the chip at once.
    chat.addContext(kind);
    onclose("pick");
  }

  function onkeydown(e: KeyboardEvent): void {
    const i = items.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        items[stepIndex(i, e.key === "ArrowDown" ? 1 : -1, entries.length)]?.focus();
        break;
      case "Home":
      case "End":
        e.preventDefault();
        items[e.key === "Home" ? 0 : entries.length - 1]?.focus();
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation(); // not the composer's Esc-to-stop
        onclose("escape");
        break;
      case "Tab":
        onclose("outside");
        break;
    }
  }
</script>

<div
  role="menu"
  tabindex="-1"
  aria-label="Add to the message"
  class="absolute bottom-full left-0 z-10 mb-1.5 flex w-72 max-w-[calc(100vw-24px)] flex-col gap-0.5 rounded-[10px] border border-widget-border bg-widget p-1.5 shadow-lg shadow-shadow"
  {onkeydown}
  {@attach outsideClick(() => onclose("outside"))}
  {@attach () => {
    queueMicrotask(() => items[0]?.focus());
  }}
>
  <div class="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
    Add to the message
  </div>
  {#each entries as e, i (e.kind)}
    <button
      bind:this={items[i]}
      type="button"
      role="menuitem"
      class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:bg-selected focus-visible:text-selected-fg"
      onclick={() => pick(e.kind)}
    >
      <ContextIcon kind={e.kind} class="size-4 opacity-75" />
      <span class="flex-1 truncate">{e.label}</span>
      <span class="shrink-0 text-small opacity-65">{e.hint}</span>
    </button>
  {/each}
  {#if images}
    <div class="mx-1 mt-1 border-t border-widget-border px-1 pt-1.5 pb-0.5 text-small text-muted">
      You can also paste an image, or hold Shift and drop files here.
    </div>
  {/if}
</div>
