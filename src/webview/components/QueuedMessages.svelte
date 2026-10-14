<script lang="ts">
  import type { ChatMeta } from "$shared/chat";
  import { chat } from "$lib/chat.svelte";

  let { meta }: { meta: ChatMeta } = $props();

  const queue = $derived(meta.queue ?? []);
</script>

<!-- Messages typed while Hermes worked (mock board 17). They go out when the
     reply ends by itself; "Send now" hands one to the running reply. After a
     Stop, a limit or an error they wait for you. -->
{#if queue.length > 0}
  <div class="mx-auto w-full max-w-4xl shrink-0 px-3 pb-1.5">
    <div
      class="flex flex-col gap-1 rounded-[10px] border border-input-border bg-input py-1.5 pr-1.5 pl-2.5"
      role="region"
      aria-label="Queued messages"
    >
      <div class="flex items-center gap-1.5 text-small text-muted">
        <svg class="size-3 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 4.5h10M3 8h10M3 11.5h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        {#if meta.busy}
          <span>Queued · sends when Hermes is done</span>
        {:else}
          <span>Queued · Hermes stopped — send it when you are ready</span>
        {/if}
      </div>
      {#each queue as q (q.id)}
        <div class="flex min-w-0 items-start gap-1">
          <span class="line-clamp-2 min-w-0 flex-1 wrap-break-word whitespace-pre-wrap text-fg">{q.text}</span>
          {#if q.chips?.length}
            <span class="shrink-0 pt-px text-small text-muted" title={q.chips.map((c) => c.label).join(", ")}>
              +{q.chips.length}
            </span>
          {/if}
          {#if !meta.busy}
            <button type="button" class="queue-link" onclick={() => chat.sendQueuedNow(q.id)}>Send</button>
          {:else if q.canSendNow}
            <button
              type="button"
              class="queue-link"
              title="Hand it to the reply Hermes is writing now: it reads it at its next step"
              onclick={() => chat.sendQueuedNow(q.id)}
            >
              Send now
            </button>
          {/if}
          <button
            type="button"
            class="row-act"
            aria-label="Edit the queued message"
            title="Edit: back into the text box"
            onclick={() => chat.editQueued(q)}
          >
            <svg class="size-3.5" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 13l1-3 7-7 2 2-7 7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            class="row-act"
            aria-label="Remove the queued message"
            title="Remove"
            onclick={() => chat.removeQueued(q.id)}
          >
            <svg class="size-3" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      {/each}
    </div>
  </div>
{/if}
