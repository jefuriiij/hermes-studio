<script lang="ts">
  import { chat } from "$lib/chat.svelte";

  const p = $derived(chat.preview);

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // not the composer's Esc-to-stop
      chat.closeImage();
    }
  }
</script>

{#if p}
  <!-- A lightbox (mock board 18): the picture floats over the dimmed chat,
       which stays in sight but is `inert` meanwhile. The × sits on the
       picture's corner; a click anywhere but the picture closes it too. -->
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Image: {p.label}"
    tabindex="-1"
    class="lightbox absolute inset-0 z-20 flex items-center justify-center p-6"
    {onkeydown}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (Esc and the Close button are the keyboard way out) -->
    <div class="absolute inset-0 cursor-zoom-out" onclick={() => chat.closeImage()}></div>
    <figure class="relative m-0 flex max-h-full max-w-full min-h-0 flex-col items-center gap-2.5">
      <button
        type="button"
        class="lightbox-close"
        aria-label="Close"
        title="Close (Esc)"
        onclick={() => chat.closeImage()}
        {@attach (el) => {
          queueMicrotask(() => el.focus());
        }}
      >
        <svg class="size-3.5" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      {#if p.src}
        <img
          src={p.src}
          alt={p.label}
          class="min-h-0 max-w-full rounded-lg object-contain shadow-[0_12px_40px] shadow-shadow"
        />
      {:else if p.missing}
        <p class="rounded-lg border border-widget-border bg-widget px-4 py-3 text-muted">
          This image is no longer available.
        </p>
      {:else}
        <span
          class="size-5 animate-spin rounded-full border-2 border-link border-t-transparent"
          role="status"
          aria-label="Loading the image"
        ></span>
      {/if}
      <figcaption class="max-w-full truncate rounded-full border border-widget-border bg-widget px-2.5 py-0.5 text-small">
        {p.label}{#if p.size}<span class="text-muted tabular-nums">{" · "}{p.size}</span>{/if}
      </figcaption>
    </figure>
  </div>
{/if}
