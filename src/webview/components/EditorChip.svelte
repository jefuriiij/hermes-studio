<script lang="ts">
  import { chat } from "$lib/chat.svelte";
  import ContextIcon from "./ContextIcon.svelte";

  const e = $derived(chat.editor);
</script>

<!-- The file you are in, which goes along with the next message (like in
     Claude). × leaves it out until you move to another file. -->
{#if e && !e.excluded}
  <span class="ctx-chip max-w-full min-w-0" title={e.detail}>
    <ContextIcon kind="editor" class="size-3 opacity-75" />
    <span class="truncate">{e.label}</span>
    <button
      type="button"
      class="ctx-chip-x"
      aria-label="Leave {e.label} out of the next message"
      title="Leave it out"
      onclick={() => chat.toggleEditor()}
    >
      <svg class="size-2.5" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
    </button>
  </span>
{:else if e}
  <button
    type="button"
    class="ctx-chip ctx-chip-off max-w-full min-w-0"
    aria-label="Include {e.label} in the next message again"
    title="Left out of the next message. Click to include it again."
    onclick={() => chat.toggleEditor()}
  >
    <svg class="size-3 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM3 13L13 3"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="8" cy="8" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3" />
    </svg>
    <span class="truncate line-through">{e.label}</span>
  </button>
{/if}
