<script lang="ts">
  import type { SentChip } from "$shared/chat";

  let { kind, class: cls = "size-3.5" }: { kind: SentChip["kind"]; class?: string } = $props();
</script>

<svg
  class={["shrink-0", cls]}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.3"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if kind === "file" || kind === "editor"}
    <path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" />
  {:else if kind === "image"}
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1.2" /><path
      d="M2.5 11.5l3.5-3.5 3 3 2-2 2.5 2.5"
    />
  {:else if kind === "selection"}
    <rect x="2" y="6" width="12" height="4" rx="1" fill="currentColor" fill-opacity="0.22" stroke="none" /><path
      d="M3.5 4h9M3.5 8h9M3.5 12h5"
    />
  {:else if kind === "skill"}
    <path d="M8 1.5l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" fill="currentColor" stroke="none" />
  {:else if kind === "problems"}
    <path d="M8 2.5l6 10.5H2z" /><path d="M8 6.5v3M8 11.3v.2" />
  {:else}
    <circle cx="5" cy="4" r="1.6" /><circle cx="5" cy="12" r="1.6" /><circle cx="11" cy="8" r="1.6" /><path
      d="M5 5.6v4.8M6.4 11.2L9.6 8.8"
    />
  {/if}
</svg>
