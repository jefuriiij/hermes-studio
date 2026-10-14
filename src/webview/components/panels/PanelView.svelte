<script lang="ts">
  import { chat } from "$lib/chat.svelte";
  import { panelId, type Tab, tabId } from "$lib/panels";
  import AgentsPanel from "./AgentsPanel.svelte";
  import CapabilitiesPanel from "./CapabilitiesPanel.svelte";
  import LearningPanel from "./LearningPanel.svelte";
  import MemoryPanel from "./MemoryPanel.svelte";

  let { tab }: { tab: Exclude<Tab, "chat"> } = $props();

  const view = $derived(chat.panels);

  /** Re-read once a minute so "12 min ago" keeps moving while a tab is open. */
  let now = $state(Date.now());
  $effect(() => {
    const timer = window.setInterval(() => (now = Date.now()), 60_000);
    return () => window.clearInterval(timer);
  });
</script>

<!-- Drawn over the chat, which stays laid out (and streaming) underneath. -->
<div
  role="tabpanel"
  id={panelId(tab)}
  aria-labelledby={tabId(tab)}
  class="absolute inset-0 overflow-y-auto"
>
  {#if !view}
    <p class="p-4 text-small text-muted">Reading Hermes's files…</p>
  {:else if !view.found}
    <p class="p-4 text-small wrap-break-word text-muted">
      Hermes's folder was not found ({view.home}). Set HERMES_HOME if Hermes keeps it elsewhere.
    </p>
  {:else if tab === "learning"}
    <LearningPanel learning={view.learning} curator={view.curator} {now} />
  {:else if tab === "memory"}
    <MemoryPanel memory={view.memory} {now} />
  {:else if tab === "capabilities"}
    <CapabilitiesPanel capabilities={view.capabilities} />
  {:else}
    <AgentsPanel agents={view.agents} {now} />
  {/if}
</div>
