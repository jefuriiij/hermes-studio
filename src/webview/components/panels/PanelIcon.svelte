<script lang="ts" module>
  export type IconName =
    | "chat"
    | "learning"
    | "memory"
    | "capabilities"
    | "agents"
    | "sparkle"
    | "pencil"
    | "plus"
    | "swap"
    | "minus"
    | "check"
    | "cross"
    | "circle"
    | "spin"
    | "copy"
    | "search"
    | "chevron"
    | "hub"
    | "person"
    | "package"
    | "plug"
    | "refresh"
    | "shield";
</script>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  // Line icons for the tabs and the panels, drawn in currentColor so every
  // theme (high contrast too) colours them. `sparkle` is Hermes's filled mark
  // for a learned skill.
  let { name, class: cls = "size-4" }: { name: IconName; class?: ClassValue } = $props();
</script>

{#if name === "sparkle"}
  <svg class={["shrink-0", cls]} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M10 6Q10 14 18 14Q10 14 10 22Q10 14 2 14Q10 14 10 6Z" />
    <path opacity="0.75" d="M18.5 2Q18.5 5.5 22 5.5Q18.5 5.5 18.5 9Q18.5 5.5 15 5.5Q18.5 5.5 18.5 2Z" />
  </svg>
{:else if name === "memory"}
  <svg class={["shrink-0", cls]} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
  </svg>
{:else}
  <svg class={["shrink-0", cls]} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if name === "chat"}
      <path d="M2.5 3.5h11v7.5H7.5l-3 2.5v-2.5h-2z" />
    {:else if name === "learning"}
      <path d="M8 1.8Q8.6 7.4 14.2 8Q8.6 8.6 8 14.2Q7.4 8.6 1.8 8Q7.4 7.4 8 1.8Z" />
    {:else if name === "capabilities"}
      <path d="M6 2.5h4v2a1.5 1.5 0 0 0 3 0V6h1.5v4h-2a1.5 1.5 0 0 0 0 3h2v1.5H10v-1.5a1.5 1.5 0 0 0-3 0v1.5H2.5V10H4a1.5 1.5 0 0 0 0-3H2.5V2.5z" />
    {:else if name === "agents"}
      <circle cx="8" cy="3.8" r="1.8" />
      <circle cx="3.8" cy="12.2" r="1.8" />
      <circle cx="12.2" cy="12.2" r="1.8" />
      <path d="M8 5.6V8M8 8l-3 2.7M8 8l3 2.7" />
    {:else if name === "pencil"}
      <path d="M3 13l1-3 7-7 2 2-7 7z" />
    {:else if name === "plus"}
      <path d="M8 3v10M3 8h10" />
    {:else if name === "swap"}
      <path d="M3 5.5h8.5L9.5 3.5M13 10.5H4.5l2 2" />
    {:else if name === "minus"}
      <path d="M3 8h10" />
    {:else if name === "check"}
      <path d="M3.5 8.5l3 3 6-7" stroke-width="1.7" />
    {:else if name === "cross"}
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-width="1.7" />
    {:else if name === "circle"}
      <circle cx="8" cy="8" r="5" />
    {:else if name === "spin"}
      <circle cx="8" cy="8" r="5" opacity="0.3" />
      <path d="M8 3a5 5 0 0 1 5 5" stroke-width="1.7" class="origin-center animate-spin" />
    {:else if name === "copy"}
      <path d="M5.5 5.5h8v8h-8zM2.5 10.5v-8h8" />
    {:else if name === "search"}
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    {:else if name === "chevron"}
      <path d="M6 4l4 4-4 4" />
    {:else if name === "hub"}
      <path d="M4.5 11.5a3 3 0 0 1 .4-6 4 4 0 0 1 7.6 1 2.5 2.5 0 0 1-.5 5M8 8v5.5M6 11.5l2 2 2-2" />
    {:else if name === "person"}
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c.6-2.8 2.6-4 5-4s4.4 1.2 5 4" />
    {:else if name === "package"}
      <path d="M2.5 5L8 2.5 13.5 5v6L8 13.5 2.5 11zM2.5 5L8 7.5 13.5 5M8 7.5v6" />
    {:else if name === "plug"}
      <path d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0zM8 11.5V14" />
    {:else if name === "refresh"}
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" />
    {:else if name === "shield"}
      <path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" />
    {/if}
  </svg>
{/if}
