<script lang="ts">
  import type { PermissionItem } from "$shared/chat";
  import { isAllow } from "$lib/format";
  import { post } from "$lib/vscode";
  import DiffBlock from "./DiffBlock.svelte";

  let { item }: { item: PermissionItem } = $props();

  const pending = $derived(item.state === "pending");
  /** The first allow is the main one (Hermes lists its narrowest allow first). */
  const primaryId = $derived(item.options.find((o) => isAllow(o.kind))?.optionId);

  /** "✕ Denied", "✓ Allowed — Allow edits this session": the label only when it adds something. */
  const answerText = $derived.by(() => {
    const a = item.answer;
    if (!a) return "";
    const head = a.allowed ? "✓ Allowed" : "✕ Denied";
    return /^(deny|allow)$/i.test(a.label) ? head : `${head} — ${a.label}`;
  });

  const openDiff = () => post({ type: "openDiff", id: item.id });
  const openFile = () => {
    // A multi-file patch names several files: nothing single to open.
    if (item.target && !item.files) post({ type: "openFile", path: item.target });
  };
</script>

<!-- Deliberately no autofocus: a card appearing while the user types must not
     be able to take a keystroke. The notification's "Show" focuses Deny. -->
<section
  class={[
    "flex flex-col overflow-hidden rounded-[10px] border",
    pending ? "border-warning/60 bg-warning/[0.07]" : "border-border",
  ]}
  aria-label={`Approval: ${item.heading}${item.target ? ` ${item.target}` : ""}`}
  data-permission-id={item.id}
>
  <div
    class={[
      "flex min-w-0 items-center gap-2 px-3 py-2 text-small",
      ((item.diff && pending) || item.action === "command" || item.detail) && "border-b border-border",
    ]}
  >
    <svg class={["size-4 shrink-0", pending ? "text-warning" : "text-muted"]} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
    </svg>
    <span class="shrink-0 font-semibold">{item.heading}</span>
    {#if item.action === "edit" && item.target}
      <button
        type="button"
        class="min-w-0 cursor-pointer truncate font-mono text-link hover:underline disabled:cursor-default disabled:text-fg disabled:no-underline"
        title={item.target}
        disabled={!!item.files}
        onclick={openFile}
      >
        {item.target}
      </button>
    {/if}
    {#if item.diff}
      <span class="shrink-0 tabular-nums">
        <span class="text-success">+{item.diff.added}</span>
        <span class="text-error">−{item.diff.removed}</span>
      </span>
    {/if}
    <span class="flex-1"></span>
    {#if item.diff}
      <button type="button" class="shrink-0 cursor-pointer text-link hover:underline" onclick={openDiff}>Open diff</button>
    {/if}
  </div>

  {#if item.action === "command" && item.target}
    <!-- The command exactly as Hermes would run it (newlines shown as ⏎). -->
    <pre class="m-0 overflow-x-auto border-b border-border bg-code-bg px-3 py-2 font-mono text-[12px] whitespace-pre-wrap"><span class="text-muted select-none">$ </span>{item.target}</pre>
  {/if}

  {#if item.detail}
    <p class="m-0 px-3 py-2 text-small wrap-break-word whitespace-pre-wrap text-muted">{item.detail}</p>
  {/if}

  <!-- Once answered, the card folds its diff away ("Open diff" stays), so old
       approvals do not fill the conversation. -->
  {#if item.diff && pending}
    <div class="px-2.5 pt-2.5">
      <DiffBlock diff={item.diff} onopen={openDiff} />
    </div>
  {/if}

  <div class="px-3 py-2.5">
    {#if pending}
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Your answer">
        {#each item.options as o (o.optionId)}
          <button
            type="button"
            class={["btn", o.optionId === primaryId ? "btn-primary" : "btn-secondary"]}
            onclick={() => post({ type: "permission", id: item.id, optionId: o.optionId })}
          >
            {o.label}
          </button>
        {/each}
      </div>
    {:else if item.state === "answered" && item.answer}
      <p class={["m-0 text-small", item.answer.allowed ? "text-success" : "text-error"]}>
        {answerText}
      </p>
    {:else if item.state === "expired"}
      <p class="m-0 text-small text-muted">Hermes stopped waiting (it timed out), so this was treated as Deny.</p>
    {:else}
      <p class="m-0 text-small text-muted">Not answered — the turn stopped, so Hermes did not do it.</p>
    {/if}
  </div>
</section>
