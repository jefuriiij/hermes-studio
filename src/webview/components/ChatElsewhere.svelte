<script lang="ts">
  import { chat } from "$lib/chat.svelte";
  import HermesMark from "./HermesMark.svelte";
</script>

<!-- The side bar while the chat is in an editor tab (mock board 15). Hermes
     keeps working there; the panel tabs above still work here. -->
<div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
  <HermesMark size={40} />
  <p class="mt-1 font-semibold text-fg">The chat is open in an editor tab</p>
  <p class="max-w-60 text-small text-muted">
    Hermes keeps working there. Close the tab, or move it back, to have the chat here again.
  </p>
  <div class="mt-2 flex flex-col items-center gap-1">
    <button type="button" class="btn btn-primary" onclick={() => chat.showChat()}>
      Show the chat
    </button>
    <button
      type="button"
      class="cursor-pointer px-1.5 py-1 text-link hover:text-link-active"
      onclick={() => chat.moveChatHere()}
    >
      Move it back here
    </button>
  </div>
</div>
