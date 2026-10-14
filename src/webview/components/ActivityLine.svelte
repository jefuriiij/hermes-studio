<script lang="ts">
  import type { ChatItem, ChatMeta } from "$shared/chat";
  import { currentActivity, formatElapsed } from "$lib/rows";

  let { items, meta }: { items: ChatItem[]; meta: ChatMeta } = $props();

  // A derived, not meta.busy read directly: every meta op (usage, title) hands
  // out a new meta object, which would restart the timer below.
  const busy = $derived(meta.busy);
  const activity = $derived(currentActivity(items, busy, meta.turn));

  // Counted here, from when this view saw the turn start: the host keeps no
  // timestamps, so after a reload the count restarts. Good enough for "is it
  // still moving?".
  let startedAt = 0;
  let now = $state(0);
  $effect(() => {
    if (!busy) return;
    startedAt = Date.now();
    now = startedAt;
    const timer = window.setInterval(() => (now = Date.now()), 1000);
    return () => window.clearInterval(timer);
  });
  const elapsed = $derived(formatElapsed((now - startedAt) / 1000));
</script>

<!-- Not a live region: it changes every second. The transcript above is the
     live region, and announces what Hermes actually says and does. -->
{#if activity}
  <div class="mx-auto flex w-full max-w-4xl shrink-0 items-center gap-2 px-4 pb-1.5 text-small text-muted">
    <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-progress" aria-hidden="true"></span>
    <span class="min-w-0 truncate" title={activity}>{activity}</span>
    <span class="shrink-0 tabular-nums">· {elapsed}</span>
    <span class="ml-auto shrink-0">Esc to stop</span>
  </div>
{/if}
