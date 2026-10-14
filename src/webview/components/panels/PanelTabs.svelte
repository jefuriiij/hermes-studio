<script lang="ts">
  import { tick } from "svelte";

  import { chat } from "$lib/chat.svelte";
  import { panelId, TABS, type Tab, tabId } from "$lib/panels";
  import PanelIcon from "./PanelIcon.svelte";

  /** `busy`: Hermes works; `waiting`: an approval card waits for the user. */
  let { busy, waiting }: { busy: boolean; waiting: boolean } = $props();

  const unseen = $derived(chat.panels?.learning.unseen ?? 0);
  /** Subagents running now: a live count (it drops as they finish). */
  const running = $derived(chat.panels?.agents.running.length ?? 0);

  /** What the Chat tab says while another tab is on screen. */
  const chatNote = $derived(
    waiting && busy ? "waiting for your approval" : busy ? "Hermes is working" : undefined,
  );

  // Icons only when the labels do not fit. Measured: the labels' width
  // depends on the editor's font. `full` is the row's width WITH labels, taken
  // while they show; the row goes back to labels once there is room for it.
  let compact = $state(false);
  let row: HTMLElement | undefined = $state();
  let full = 0;
  function fit(): void {
    if (!row) return;
    if (!compact) {
      full = row.scrollWidth;
      if (row.scrollWidth > row.clientWidth + 1) compact = true;
    } else if (row.clientWidth >= full) {
      compact = false;
    }
  }
  $effect(() => {
    if (!row) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(row);
    return () => ro.disconnect();
  });
  // The labels' width changes with the badge and the Chat dot: measure again.
  $effect(() => {
    void [compact, unseen, running, chatNote, chat.tab];
    void tick().then(fit);
  });

  /** Arrow keys move between tabs (and switch), as a tab list does. */
  function onkeydown(e: KeyboardEvent): void {
    const i = TABS.findIndex((t) => t.id === chat.tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    const tab = TABS[next];
    if (!tab) return;
    e.preventDefault();
    chat.setTab(tab.id);
    void tick().then(() => document.getElementById(tabId(tab.id))?.focus());
  }

  /** The tab's name, with what its dot or count means when it shows one. */
  function name(t: Tab, label: string): string {
    if (t === "chat" && chatNote && chat.tab !== "chat") return `${label}, ${chatNote}`;
    if (t === "learning" && unseen > 0 && chat.tab !== "learning") {
      return `${label}, ${unseen} changed since you last looked`;
    }
    if (t === "agents" && running > 0 && chat.tab !== "agents") return `${label}, ${running} running`;
    return label;
  }
</script>

<div
  bind:this={row}
  role="tablist"
  aria-label="Hermes Studio"
  class="flex shrink-0 overflow-hidden border-b border-border px-1.5"
>
  {#each TABS as t (t.id)}
    {@const selected = chat.tab === t.id}
    {@const label = name(t.id, t.label)}
    <button
      type="button"
      role="tab"
      id={tabId(t.id)}
      aria-selected={selected}
      aria-controls={panelId(t.id)}
      aria-label={label}
      tabindex={selected ? 0 : -1}
      class="view-tab"
      data-compact={compact || undefined}
      title={compact || label !== t.label ? label : undefined}
      onclick={() => chat.setTab(t.id)}
      {onkeydown}
    >
      <PanelIcon name={t.id} />
      {#if !compact}<span>{t.label}</span>{/if}
      {#if t.id === "chat" && chatNote && !selected}
        <!-- Waiting on YOU beats working: the warning colour, as the header's "Needs you". -->
        <span
          class={[
            "tab-dot size-[7px] shrink-0 rounded-full border border-hc",
            waiting ? "bg-warning" : "animate-pulse bg-progress",
          ]}
          aria-hidden="true"
        ></span>
      {:else if t.id === "learning" && unseen > 0 && !selected}
        <span class="tab-badge" aria-hidden="true">{unseen}</span>
      {:else if t.id === "agents" && running > 0 && !selected}
        <span class="tab-badge" aria-hidden="true">{running}</span>
      {/if}
    </button>
  {/each}
</div>
