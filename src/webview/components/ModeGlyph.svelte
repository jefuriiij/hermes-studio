<script lang="ts">
  import type { ModeIcon } from "$lib/format";

  let { icon, class: cls = "size-3.5" }: { icon: ModeIcon; class?: string } = $props();
</script>

<svg
  class={["shrink-0", cls]}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.35"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if icon === "hand"}
    <path d="M5.5 8V3.5a1 1 0 0 1 2 0V7" /><path d="M7.5 6.5V2.8a1 1 0 0 1 2 0V7" /><path
      d="M9.5 6.8V3.8a1 1 0 0 1 2 0V9c0 2.8-1.7 5-4.3 5-1.8 0-2.9-.9-3.9-2.5L2 9.2a1 1 0 0 1 1.6-1.2L5.5 10"
    />
  {:else if icon === "code"}
    <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3l-2 10" />
  {:else if icon === "bolt"}
    <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" />
  {:else}
    <path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" />
  {/if}
</svg>
