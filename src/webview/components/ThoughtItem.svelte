<script lang="ts">
  let { text, active }: { text: string; active: boolean } = $props();
</script>

<!-- Native <details>: collapsed by default, keyboard and screen-reader support
     for free, and the open state lives in the DOM so it survives re-renders. -->
<details class="group text-small text-muted">
  <summary
    class="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm py-0.5 pr-1 select-none hover:text-fg [&::-webkit-details-marker]:hidden"
  >
    <svg
      class="size-3 shrink-0 transition-transform group-open:rotate-90"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
    {#if active}
      <span class="animate-pulse">Thinking…</span>
    {:else}
      <span>Thought</span>
    {/if}
  </summary>
  <!-- Plain text on purpose: reasoning is not rendered as markdown. -->
  <div class="mt-1 mb-1 ml-1.5 border-l-2 border-quote-border pl-2.5 wrap-break-word whitespace-pre-wrap">
    {text}
  </div>
</details>
