<script lang="ts">
  import { chat } from "$lib/chat.svelte";
  import { BlockRenderer } from "$lib/markdown";

  /** `streaming`: Hermes is still writing this message (shows the caret). */
  let { text, streaming = false }: { text: string; streaming?: boolean } = $props();

  // One renderer per message: it holds the per-block cache that keeps
  // finished blocks from being re-parsed while the reply streams.
  const renderer = new BlockRenderer();
  const blocks = $derived(renderer.render(text));

  // Path-like `code` (marked in lib/markdown.ts): ask the host which are real
  // files; those become gold and clickable (the click is delegated, see
  // lib/delegate.ts). Again after every render: a streamed block is new DOM.
  let root: HTMLElement | undefined = $state();
  $effect(() => {
    void blocks;
    if (!root) return;
    const ask: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("code.md-path")) {
      const path = el.dataset.path ?? "";
      const known = chat.files.get(path);
      if (known === undefined) ask.push(path);
      const file = known === true;
      el.classList.toggle("is-file", file);
      if (file) {
        el.setAttribute("role", "link");
        el.tabIndex = 0;
        el.title = `Open ${path}${el.dataset.line ? `, line ${el.dataset.line}` : ""}`;
      }
    }
    if (ask.length) chat.checkPaths(ask);
  });
</script>

<div class="md" data-streaming={streaming || undefined} bind:this={root}>
  {#each blocks as block (block.key)}
    <!-- Sanitized by DOMPurify in lib/markdown.ts; raw HTML was escaped before that. -->
    {@html block.html}
  {/each}
</div>
