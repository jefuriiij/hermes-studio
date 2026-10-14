<script lang="ts">
  import type { ChatMeta } from "$shared/chat";
  import { chat } from "$lib/chat.svelte";
  import { formatTokens } from "$lib/format";
  import { outsideClick } from "$lib/outside";
  import { post } from "$lib/vscode";

  let {
    meta,
    onclose,
  }: { meta: ChatMeta; onclose: (why: "pick" | "escape" | "outside") => void } = $props();

  // Hermes's `/context` (local: no tokens, not added to the chat). Only while
  // idle; until it answers, the ring's own numbers show.
  chat.requestContextInfo();

  const report = $derived(chat.contextInfo);
  const info = $derived(report.info);
  const used = $derived(info?.used ?? meta.usage?.used);
  const size = $derived(info?.size ?? meta.usage?.size);
  const ratio = $derived(used !== undefined && size ? Math.min(1, used / size) : undefined);
  const pctLabel = $derived(
    ratio === undefined ? "" : ratio > 0 && ratio < 0.01 ? "<1%" : `${Math.round(ratio * 100)}%`,
  );
  const tick = $derived(info?.autoCompress !== false ? info?.thresholdPct : undefined);
  const roles = $derived(info?.byRole);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  function compress(): void {
    post({ type: "compress" });
    onclose("pick");
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // not the composer's Esc-to-stop
      onclose("escape");
    } else if (e.key === "Tab" && !(e.target instanceof HTMLButtonElement)) {
      onclose("outside");
    }
  }
</script>

<div
  role="dialog"
  tabindex="-1"
  aria-label="Context usage"
  class="absolute bottom-full left-0 mb-1.5 flex w-80 max-w-[calc(100vw-24px)] flex-col gap-2.5 rounded-[10px] border border-widget-border bg-widget px-3.5 py-3 shadow-lg shadow-shadow outline-none"
  {onkeydown}
  {@attach outsideClick(() => onclose("outside"))}
  {@attach (el) => {
    queueMicrotask(() => el.focus());
  }}
>
  <div class="flex items-baseline gap-2">
    <span class="font-semibold">Context</span>
    <span class="flex-1"></span>
    {#if used !== undefined && size}
      <span class="text-small text-muted tabular-nums">~{formatTokens(used)} / {formatTokens(size)} tokens</span>
    {/if}
  </div>

  {#if ratio !== undefined}
    <div class="flex flex-col gap-1">
      <span class="text-small">{pctLabel} full</span>
      <div class="relative h-2 rounded-full bg-fg/15" aria-hidden="true">
        <div class="absolute inset-y-0 left-0 rounded-full bg-muted" style:width="max({ratio * 100}%, 4px)"></div>
        {#if tick}
          <div class="absolute -inset-y-0.75 w-0.5 rounded-full bg-warning" style:left="{tick}%"></div>
        {/if}
      </div>
      {#if tick}
        <div class="relative h-4 text-[11px] text-warning">
          <span class="absolute right-0">compresses at {tick}%</span>
        </div>
      {:else if info?.autoCompress === false}
        <span class="text-[11px] text-muted">Automatic compression is off.</span>
      {/if}
    </div>
  {:else}
    <p class="text-small text-muted">Hermes reports the context after its first reply.</p>
  {/if}

  <dl class="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1 border-t border-border pt-2.5 text-small">
    <dt class="text-muted">Messages</dt>
    <dd>
      {#if info}
        {info.messages}{#if roles && info.messages > 0}{" — "}{roles.user} from you, {roles.assistant} from
          Hermes{#if roles.tool}, {plural(roles.tool, "tool result", "tool results")}{/if}{/if}
      {:else if report.loading}
        …
      {:else}
        <span class="text-muted">when Hermes is idle</span>
      {/if}
    </dd>
    <dt class="text-muted">Model</dt>
    <dd class="truncate">
      {info?.model ?? meta.model ?? "…"}{#if size}&nbsp;· {formatTokens(size)} window{/if}
    </dd>
    <dt class="text-muted">Compression</dt>
    <dd>
      {#if !info}
        {report.loading ? "…" : "—"}
      {:else if info.autoCompress === false}
        off (only “Compress now”)
      {:else if info.compressDue}
        <span class="text-warning">due now</span>
      {:else if info.compressIn !== undefined}
        in ~{formatTokens(info.compressIn)} tokens
      {:else}
        —
      {/if}
    </dd>
  </dl>

  <div class="flex items-center gap-2.5">
    <button
      type="button"
      class="btn btn-secondary shrink-0"
      disabled={meta.busy || !info || info.messages === 0}
      title={meta.busy ? "Wait until Hermes is done" : "Send /compress"}
      onclick={compress}
    >
      Compress now
    </button>
    <span class="text-[11px] leading-snug text-muted">Hermes sums up older messages to free space. This uses the model.</span>
  </div>
</div>
