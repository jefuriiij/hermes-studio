<script lang="ts">
  import Markdown from "./Markdown.svelte";

  let { text }: { text: string } = $props();
</script>

<!-- Hermes's summary of older messages, in place of them. Folded like a
     thought: a line across the chat, the summary itself one click away. -->
<details class="group my-1 text-small text-muted">
  <summary
    class="flex cursor-pointer list-none items-center gap-2 rounded-sm py-0.5 select-none hover:text-fg [&::-webkit-details-marker]:hidden"
  >
    <span class="h-px flex-1 bg-quote-border" aria-hidden="true"></span>
    <svg
      class="size-3 shrink-0 transition-transform group-open:rotate-90"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
    <span>Earlier messages were summarized</span>
    <span class="h-px flex-1 bg-quote-border" aria-hidden="true"></span>
  </summary>
  <div class="mt-1 mb-1 ml-1.5 border-l-2 border-quote-border pl-2.5">
    <Markdown {text} streaming={false} />
  </div>
</details>
