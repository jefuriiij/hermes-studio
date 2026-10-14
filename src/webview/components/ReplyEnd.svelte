<script lang="ts">
  import type { ChatItem, ChatMeta } from "$shared/chat";
  import { copyText } from "$lib/delegate";
  import { changedFiles } from "$lib/paths";
  import { tookText } from "$shared/time";
  import { post } from "$lib/vscode";

  /** The end of one reply (mock board 23): the files it changed, how long it
   *  took, Copy and — on the newest reply — Retry. */
  let { turn, items, meta }: { turn: number; items: ChatItem[]; meta: ChatMeta } = $props();

  const own = $derived(items.filter((i) => i.turn === turn));
  const files = $derived(
    changedFiles(own.flatMap((i) => (i.kind === "tool" && i.diff ? [{ id: i.id, diff: i.diff }] : []))),
  );
  const reply = $derived(
    own
      .flatMap((i) => (i.kind === "assistant" && i.text.trim() ? [i.text.trim()] : []))
      .join("\n\n"),
  );
  const asked = $derived(own.find((i) => i.kind === "user" && !i.steered));
  const took = $derived(asked?.kind === "user" && asked.ms !== undefined ? tookText(asked.ms) : "");
  // Retry sends the text (and skill) again: not when the message carried files
  // or images, which are not kept after sending.
  const retry = $derived.by(() => {
    if (asked?.kind !== "user" || asked.notSent || meta.busy || turn !== meta.turn) return undefined;
    const chips = asked.attachments ?? [];
    if (chips.some((c) => c.kind === "file" || c.kind === "image")) return undefined;
    return { text: asked.text, skill: chips.find((c) => c.kind === "skill")?.label };
  });

  let copied = $state<"idle" | "done" | "failed">("idle");
  async function copy(): Promise<void> {
    copied = (await copyText(reply)) ? "done" : "failed";
    setTimeout(() => (copied = "idle"), 1500);
  }
</script>

{#if files.length > 0}
  <div class="reply-changed" role="group" aria-label="Files changed in this reply">
    <div class="px-1.5 pb-0.5 text-[11px] font-semibold tracking-wider text-muted uppercase">
      Changed in this reply · {files.length} {files.length === 1 ? "file" : "files"}
    </div>
    {#each files as f (f.path)}
      <button
        type="button"
        class="reply-file"
        title={f.edits > 1 ? `Open the last of ${f.edits} changes as a diff` : "Open the change as a diff"}
        onclick={() => post({ type: "openDiff", id: f.toolId })}
      >
        <svg class="size-3.5 shrink-0 text-hermes" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M9 2H4.5v12h7V4.5z M9 2v2.5h2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
        <span class="min-w-0 flex-1 truncate font-mono text-small">{f.path}</span>
        <span class="shrink-0 text-small text-success tabular-nums">+{f.added}</span>
        <span class="shrink-0 text-small text-error tabular-nums">−{f.removed}</span>
      </button>
    {/each}
  </div>
{/if}
{#if reply || took}
  <div class="reply-foot">
    {#if took}<span class="pr-1.5">{took}</span>{/if}
    {#if reply}
      <button type="button" class="reply-act" onclick={copy} aria-label="Copy the reply">
        <svg class="size-3" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2h6" fill="none" stroke="currentColor" stroke-width="1.3" />
        </svg>
        {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
      </button>
    {/if}
    {#if retry}
      <button
        type="button"
        class="reply-act"
        aria-label="Send my message again"
        title="Send your message again"
        onclick={() => post({ type: "send", text: retry.text, ...(retry.skill ? { skill: retry.skill } : {}) })}
      >
        <svg class="size-3" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Retry
      </button>
    {/if}
  </div>
{/if}
