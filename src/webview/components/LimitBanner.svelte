<script lang="ts">
  import type { ChatMeta } from "$shared/chat";
  import { chat } from "$lib/chat.svelte";
  import { limitCopy } from "$lib/format";
  import { suggestModel } from "$lib/models";
  import { post } from "$lib/vscode";

  let { meta }: { meta: ChatMeta } = $props();

  const limit = $derived(meta.limit);
  const copy = $derived(limit ? limitCopy(limit) : undefined);
  const next = $derived(suggestModel(meta.models ?? [], meta.modelId, limit?.provider));
  const shown = $derived(!!limit && !meta.busy && !meta.switchingModel);
</script>

<!-- A polite status: it appears after the turn, while the user is reading. -->
{#if shown && copy}
  <div class="mx-auto w-full max-w-4xl shrink-0 px-3 pb-2" role="status">
    <div class="relative flex flex-col gap-2.5 rounded-[10px] border border-warning/45 bg-warning/10 p-3 pr-8">
      <button
        type="button"
        class="btn btn-ghost absolute top-1.5 right-1.5 size-6 p-0"
        aria-label="Dismiss"
        title="Dismiss"
        onclick={() => post({ type: "dismissLimit" })}
      >
        <svg class="size-3" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      <div class="flex items-start gap-2.5">
        <svg class="mt-0.5 size-4 shrink-0 text-warning" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0zM8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="font-semibold">{copy.title}</span>
          <span class="text-small text-muted">{copy.body}</span>
        </div>
      </div>
      <div class="flex flex-wrap gap-1.5">
        {#if next}
          <button type="button" class="btn btn-primary" onclick={() => post({ type: "continueWith", modelId: next.id })}>
            Continue with {next.label}
            {#if next.provider}<span class="font-normal opacity-80">· {next.provider}</span>{/if}
          </button>
        {/if}
        {#if (meta.models?.length ?? 0) > 1}
          <button
            type="button"
            class={["btn", next ? "btn-secondary" : "btn-primary"]}
            data-menu-trigger
            onclick={() => (chat.menu = "model")}
          >
            Choose another model
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
