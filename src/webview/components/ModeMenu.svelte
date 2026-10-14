<script lang="ts">
  import type { ChatMeta } from "$shared/chat";
  import { chat } from "$lib/chat.svelte";
  import { modeDescription, modeIcon, modeLabel } from "$lib/format";
  import { stepIndex } from "$lib/models";
  import { outsideClick } from "$lib/outside";
  import { post } from "$lib/vscode";
  import EffortSlider from "./EffortSlider.svelte";
  import ModeGlyph from "./ModeGlyph.svelte";

  let {
    meta,
    onclose,
  }: { meta: ChatMeta; onclose: (why: "pick" | "escape" | "outside") => void } = $props();

  const modes = $derived(meta.modes ?? []);
  const effort = $derived(chat.effort);
  /** The modes, then the effort slider: one list for Up/Down (the slider
   *  takes Left/Right itself). */
  let items: HTMLElement[] = $state([]);

  // The setting may have changed in Hermes's terminal: read it on every open.
  chat.refreshEffort();

  function pick(id: string): void {
    if (id !== meta.mode) post({ type: "setMode", modeId: id });
    onclose("pick");
  }

  // A menu opens with focus on its checked mode (or the first).
  function focusInitial(): void {
    const i = Math.max(
      0,
      modes.findIndex((m) => m.id === meta.mode),
    );
    items[i]?.focus();
  }

  function onkeydown(e: KeyboardEvent): void {
    const i = items.indexOf(document.activeElement as HTMLElement);
    const n = modes.length + 1;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "ArrowLeft":
      case "ArrowRight": {
        // In the modes Left/Right step like Up/Down; on the slider they
        // change the effort (it stops them first).
        e.preventDefault();
        const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
        items[stepIndex(i, forward ? 1 : -1, n)]?.focus();
        break;
      }
      case "Home":
      case "End":
        e.preventDefault();
        items[e.key === "Home" ? 0 : n - 1]?.focus();
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
  aria-label="Mode and effort"
  class="absolute right-0 bottom-full mb-1.5 flex w-84 max-w-[calc(100vw-24px)] flex-col gap-0.5 rounded-[10px] border border-widget-border bg-widget p-1.5 shadow-lg shadow-shadow"
  {onkeydown}
  {@attach outsideClick(() => onclose("outside"))}
  {@attach () => {
    queueMicrotask(focusInitial);
  }}
>
  <div class="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
    When Hermes edits files
  </div>
  <div role="group" aria-label="Mode" class="flex flex-col gap-0.5">
    {#each modes as m, i (m.id)}
      {@const checked = m.id === meta.mode}
      {@const description = modeDescription(m)}
      <button
        bind:this={items[i]}
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        class={[
          "flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:bg-selected focus-visible:text-selected-fg",
          checked && "bg-selected/60",
        ]}
        onclick={() => pick(m.id)}
      >
        <ModeGlyph icon={modeIcon(m)} class="mt-0.5 size-4 opacity-85" />
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="text-small font-semibold">{modeLabel(m)}</span>
          {#if description}
            <span class="text-small opacity-75">{description}</span>
          {/if}
        </span>
        {#if checked}
          <svg class="mt-0.5 size-3.5 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        {/if}
      </button>
    {/each}
  </div>
  <p class="px-2 pt-0.5 pb-1 pl-8.5 text-[11px] text-muted">
    In every mode, sensitive files and risky commands still ask.
  </p>

  <div class="mx-1 my-0.5 border-t border-widget-border"></div>

  <EffortSlider
    bind:el={items[modes.length]}
    value={effort.value}
    loading={effort.loading}
    saving={effort.saving}
    error={effort.error}
    onpick={(level) => chat.setEffort(level)}
  />
  <p class="px-2 pb-1 text-[11px] text-muted">
    How hard Hermes thinks. Used from your next new chat, in all of Hermes.
  </p>
  {#if effort.error}
    <p class="px-2 pb-1 text-[11px] text-error" role="alert">{effort.error}</p>
  {/if}
</div>
