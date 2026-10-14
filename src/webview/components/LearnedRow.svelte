<script lang="ts">
  import { chat } from "$lib/chat.svelte";
  import { learnedRow } from "$lib/welcome";

  // Re-read once a minute so "12 min ago" moves while the empty chat is up.
  let now = $state(Date.now());
  $effect(() => {
    const timer = window.setInterval(() => (now = Date.now()), 60_000);
    return () => window.clearInterval(timer);
  });

  const row = $derived(learnedRow(chat.panels, now));
</script>

<!-- The empty chat's "Hermes learned …" row (mock board 2): a brain while
     things are quiet, sparkles when Hermes learned something since you last
     looked. It opens the Learning tab. -->
{#if row}
  <button
    type="button"
    class={["learned-row", row.kind === "fresh" && "learned-row-fresh"]}
    onclick={() => chat.setTab("learning")}
    title="Open the Learning tab"
  >
    {#if row.kind === "fresh"}
      <svg class="learned-stars size-4.5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
        <path class="star" d="M10 6Q10 14 18 14Q10 14 10 22Q10 14 2 14Q10 14 10 6Z" />
        <path class="star star-2" d="M18.5 2Q18.5 5.5 22 5.5Q18.5 5.5 18.5 9Q18.5 5.5 15 5.5Q18.5 5.5 18.5 2Z" />
        <path class="star star-3" d="M19.5 15Q19.5 17.5 22 17.5Q19.5 17.5 19.5 20Q19.5 17.5 17 17.5Q19.5 17.5 19.5 15Z" />
      </svg>
      <span class="flex min-w-0 flex-1 flex-col text-left">
        <span class="learned-sheen font-semibold">{row.title}</span>
        <span class="truncate text-small text-muted">
          <span class="font-mono text-fg">{row.skill}</span> · {row.when}{row.more > 0 ? ` · +${row.more} more` : ""}
        </span>
      </span>
    {:else}
      <svg class="size-4 shrink-0 text-hermes" viewBox="0 0 24 24" aria-hidden="true">
        <g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
          <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
          <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
        </g>
      </svg>
      <span class="min-w-0 flex-1 text-left">
        <span class="text-fg">{row.text}</span>{#if row.curator}<span class="text-muted">{" · "}{row.curator}</span>{/if}
      </span>
    {/if}
    <svg class="size-3 shrink-0 text-muted" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
{/if}
