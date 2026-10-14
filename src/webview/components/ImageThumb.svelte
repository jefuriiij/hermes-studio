<script lang="ts">
  import { chat } from "$lib/chat.svelte";
  import ContextIcon from "./ContextIcon.svelte";

  /** The chip id; without one (or until the picture arrives) the icon shows. */
  let { id }: { id: string | undefined } = $props();

  const src = $derived(id ? chat.thumbs.get(id) : undefined);

  $effect(() => {
    if (id) chat.wantThumb(id);
  });
</script>

{#if src}
  <img {src} alt="" class="size-4 shrink-0 rounded-[3px] object-cover outline-1 -outline-offset-1 outline-fg/15" />
{:else}
  <ContextIcon kind="image" class="size-3 opacity-75" />
{/if}
