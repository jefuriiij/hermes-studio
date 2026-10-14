<script lang="ts">
  import { untrack } from "svelte";
  import type { ChatMeta } from "$shared/chat";
  import { chat } from "$lib/chat.svelte";
  import { filterModels, groupModels, stepIndex } from "$lib/models";
  import { outsideClick } from "$lib/outside";
  import { slugOf, type UsageView, usageView } from "$lib/usage";
  import { post } from "$lib/vscode";

  let {
    meta,
    onclose,
  }: { meta: ChatMeta; onclose: (why: "pick" | "escape" | "outside") => void } = $props();

  let query = $state("");
  const shown = $derived(filterModels(meta.models ?? [], query));
  const groups = $derived(groupModels(shown));
  /** Flat order of the options, for the arrow keys. */
  const flat = $derived(groups.flatMap((g) => g.items));
  const indexOf = $derived(new Map(flat.map((m, i) => [m.id, i])));

  // Opens on the current model; typing moves to the first match.
  let active = $state(untrack(() => flat.findIndex((m) => m.id === meta.modelId)));
  const listId = $props.id();
  const optionId = (i: number) => `${listId}-${i}`;

  // Subscription limits per provider ("24% used"): the host re-reads them
  // unless it did within the last minute, so opening the menu is enough.
  post({ type: "refreshUsage" });
  const openedAt = Date.now();
  const usageFor = (items: { id: string }[]): UsageView | undefined =>
    usageView(chat.accountUsage.byProvider[slugOf(items[0]?.id)], openedAt);
  const checking = (items: { id: string }[]): boolean =>
    chat.accountUsage.loading.includes(slugOf(items[0]?.id));
  const TONE = { muted: "text-muted", warning: "text-warning", error: "text-error" } as const;

  let list: HTMLElement | undefined;
  $effect(() => {
    if (active < 0 || !list) return;
    list.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: "nearest" });
  });

  function pick(i: number): void {
    const m = flat[i];
    if (!m) return;
    // After a limit, a pick is the banner's promise: switch AND resend.
    if (meta.limit) post({ type: "continueWith", modelId: m.id });
    else if (m.id !== meta.modelId) post({ type: "setModel", modelId: m.id });
    onclose("pick");
  }

  function onkeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        active = stepIndex(active, e.key === "ArrowDown" ? 1 : -1, flat.length);
        break;
      case "Home":
      case "End":
        if (!e.ctrlKey) return; // plain Home/End move the caret in the search box
        e.preventDefault();
        active = e.key === "Home" ? 0 : flat.length - 1;
        break;
      case "Enter":
        e.preventDefault();
        pick(active);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation(); // not the composer's Esc-to-stop
        onclose("escape");
        break;
    }
  }
</script>

<div
  class="absolute right-0 bottom-full left-0 mb-1.5 flex max-h-[min(60vh,420px)] flex-col overflow-hidden rounded-[10px] border border-widget-border bg-widget shadow-lg shadow-shadow"
  {@attach outsideClick(() => onclose("outside"))}
>
  <div class="shrink-0 p-1.5 pb-1">
    <input
      {@attach (el) => el.focus()}
      bind:value={query}
      oninput={() => (active = flat.length > 0 ? 0 : -1)}
      {onkeydown}
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls={listId}
      aria-activedescendant={active >= 0 ? optionId(active) : undefined}
      aria-label="Search models"
      placeholder="Search models"
      class="h-7 w-full rounded-md border border-input-border bg-input px-2.5 text-input-fg outline-none placeholder:text-placeholder focus:outline-1 focus:-outline-offset-1 focus:outline-focus"
    />
  </div>

  <div id={listId} role="listbox" aria-label="Models" class="min-h-0 flex-1 overflow-y-auto px-1.5" bind:this={list}>
    {#if flat.length === 0}
      <p class="px-2 py-2 text-small text-muted">No model matches “{query}”.</p>
    {/if}
    {#each groups as g (g.provider)}
      {@const u = usageFor(g.items)}
      <div role="group" aria-label={u ? `${g.provider}, ${u.text}${u.full && u.resets ? `, resets ${u.resets}` : ""}` : g.provider}>
        <div
          class="flex items-center gap-2 px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase"
          title={u?.tooltip}
        >
          <span class="min-w-0 flex-1 truncate">{g.provider}</span>
          {#if u}
            <span
              class={[
                "shrink-0 tracking-normal normal-case tabular-nums",
                TONE[u.tone],
                u.tone === "muted" ? "font-normal" : "font-semibold",
              ]}>{u.text}</span
            >
          {:else if checking(g.items)}
            <span class="shrink-0 font-normal tracking-normal normal-case opacity-75">checking…</span>
          {/if}
        </div>
        {#if u?.percent !== undefined}
          <div class={["mx-2 mb-1 h-[3px] overflow-hidden rounded-full bg-fg/15", TONE[u.tone]]} aria-hidden="true">
            <div class="h-full rounded-full bg-current" style:width="{Math.max(u.ratio * 100, 1.5)}%"></div>
          </div>
        {/if}
        {#each g.items as m (m.id)}
          {@const i = indexOf.get(m.id) ?? -1}
          {@const current = m.id === meta.modelId}
          <!-- Options, not buttons: focus stays in the search box (combobox
               pattern); a click picks, the pointer moves the highlight. -->
          <div
            id={optionId(i)}
            role="option"
            tabindex="-1"
            aria-selected={i === active}
            class={[
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-small",
              i === active ? "bg-selected text-selected-fg" : "",
              u?.full && i !== active && "opacity-60",
            ]}
            title={u?.full ? `${m.id} — this subscription is used up${u.resets ? ` until ${u.resets}` : ""}` : m.id}
            onpointermove={() => (active = i)}
            onclick={() => pick(i)}
            onkeydown={() => undefined}
          >
            <span class="min-w-0 flex-1 truncate">{m.label}</span>
            {#if u?.full && u.resets}
              <span class="shrink-0 opacity-80">resets {u.resets}</span>
            {/if}
            {#if current}
              <svg class="size-3.5 shrink-0" viewBox="0 0 16 16" aria-label="current model">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>

  <p class="shrink-0 border-t border-border px-3 py-1.5 text-small text-muted">
    {meta.limit ? "Your message is sent again on the model you pick" : "Switching keeps this conversation"}
    · Enter to switch · Esc to close
  </p>
</div>
