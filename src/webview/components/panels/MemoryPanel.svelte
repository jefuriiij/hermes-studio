<script lang="ts">
  import type { MemoryFile, MemoryView, PendingRow } from "$shared/panels";
  import { relativeTime } from "$shared/time";
  import { SvelteMap } from "svelte/reactivity";
  import { chat } from "$lib/chat.svelte";
  import { kChars, pendingHeading, pendingItems, plural, reviewedText } from "$lib/panels";
  import PanelIcon from "./PanelIcon.svelte";

  let { memory, now }: { memory: MemoryView; now: number } = $props();

  /** Entries per file before "Show all". */
  const FIRST = 4;
  let allNotes = $state(false);
  let allProfile = $state(false);

  const COMMAND = "/memory pending";
  let copied = $state<"done" | "failed" | null>(null);
  let copyTimer: number | undefined;
  async function copyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(COMMAND);
      copied = "done";
    } catch {
      copied = "failed";
    }
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => (copied = null), 1500);
  }

  // ── Answering proposals (mock boards 27A/B) ─────────────────────────────
  const items = $derived(pendingItems(memory.pending));
  /** The version picked in each "pick one" card (default: the newest). */
  const picked = new SvelteMap<string, string>();
  const pickOf = (group: string, rows: PendingRow[]) => {
    const id = picked.get(group);
    return rows.some((r) => r.id === id) ? (id as string) : (rows[0]?.id ?? "");
  };
  const busy = (rows: readonly PendingRow[]) => rows.some((r) => chat.reviewing.has(r.id));
  const NEXT_CHAT = " Hermes uses it from your next new chat.";

  function approve(row: PendingRow, others: readonly PendingRow[] = []): void {
    chat.reviewMemory(
      row.id,
      others.map((r) => r.id),
      reviewedText(row, 0) + NEXT_CHAT,
    );
  }
  function reject(rows: readonly PendingRow[]): void {
    chat.reviewMemory(
      undefined,
      rows.map((r) => r.id),
      reviewedText(undefined, rows.length),
    );
  }
  /** "Reject all" asks once more (Hermes deletes proposals for good). */
  let confirmAll = $state(false);
  let confirmTimer: number | undefined;
  function rejectAll(): void {
    if (!confirmAll) {
      confirmAll = true;
      window.clearTimeout(confirmTimer);
      confirmTimer = window.setTimeout(() => (confirmAll = false), 4000);
      return;
    }
    confirmAll = false;
    reject(memory.pending);
  }
  const radioName = $props.id();

  /** Why Hermes can't apply it: the two ways a proposal goes out of date. */
  const whyOutdated = (p: PendingRow) =>
    p.changed
      ? "That entry has changed since Hermes proposed this, so Hermes can't apply it. Reject it; Hermes proposes a new change if it still matters."
      : "Made by an older Hermes, which can't apply it. Reject it; Hermes proposes it again if it still matters.";

  const meters: { title: string; file: MemoryFile; name: string }[] = $derived([
    { title: "Notes", file: memory.notes, name: "MEMORY.md" },
    { title: "About you", file: memory.profile, name: "USER.md" },
  ]);
  const full = (f: MemoryFile) => (f.limit > 0 ? Math.min(100, (f.chars / f.limit) * 100) : 0);
</script>

<div class="flex flex-col gap-3 p-3.5">
  <div class="flex items-center gap-2">
    <span class="min-w-0 flex-1 text-small text-muted">Hermes reads these at the start of every new chat.</span>
    <button
      type="button"
      class="icon-btn"
      aria-label="Refresh: read Hermes's memory again"
      title="Read Hermes's memory again"
      disabled={chat.refreshing}
      onclick={() => chat.refreshPanels()}
    >
      <PanelIcon name={chat.refreshing ? "spin" : "refresh"} class="size-4" />
    </button>
  </div>

  <!-- How full each file is (Hermes caps them; a full one makes it compress). -->
  <div class="grid grid-cols-2 gap-2.5">
    {#each meters as m (m.name)}
      <button
        type="button"
        class="panel-card flex cursor-pointer flex-col gap-1.5 px-3 py-2.5 text-left hover:bg-hover"
        title="Open {m.name}"
        onclick={() => chat.openPanel(m.file.open)}
      >
        <span class="flex flex-wrap items-baseline gap-x-1.5">
          <span class="font-semibold">{m.title}</span>
          <span class="text-small text-muted">{plural(m.file.entries.length, "entry", "entries")}</span>
        </span>
        <span
          class="block h-1 overflow-hidden rounded-sm bg-fg/12"
          role="meter"
          aria-label="{m.title}: {kChars(m.file.chars)} of {kChars(m.file.limit)} characters"
          aria-valuemin={0}
          aria-valuemax={m.file.limit}
          aria-valuenow={Math.min(m.file.chars, m.file.limit)}
        >
          <span
            class={["block h-full", full(m.file) >= 90 ? "bg-warning" : "bg-link"]}
            style:width="{full(m.file)}%"
          ></span>
        </span>
        <span class="text-small text-muted tabular-nums">{kChars(m.file.chars)} of {kChars(m.file.limit)} chars</span>
      </button>
    {/each}
  </div>

  {#if memory.pending.length > 0 || chat.reviewNote}
    <div class="flex items-center justify-between gap-2">
      <h2 class="section-label">
        Waiting for your OK
        {#if memory.pending.length > 0}
          <span class="tab-badge bg-muted! text-surface!">{memory.pending.length}</span>
        {/if}
      </h2>
      {#if memory.pending.length > 1}
        <button
          type="button"
          class={["btn btn-ghost py-0! text-small", confirmAll && "text-error!"]}
          disabled={busy(memory.pending)}
          onclick={rejectAll}
        >
          {confirmAll ? `Reject all ${memory.pending.length}?` : "Reject all"}
        </button>
      {/if}
    </div>
    <div class="panel-card">
      {#if chat.reviewNote}
        <div
          role="status"
          class={[
            "flex items-start gap-2.5 px-3 py-2.5 text-small",
            chat.reviewNote.ok ? "bg-success/10" : "bg-error/10",
          ]}
        >
          <PanelIcon
            name={chat.reviewNote.ok ? "check" : "cross"}
            class={["mt-0.5 size-3.5", chat.reviewNote.ok ? "text-success" : "text-error"]}
          />
          <span class="min-w-0 wrap-break-word">{chat.reviewNote.text}</span>
        </div>
      {/if}
      {#each items as it (it.kind === "one" ? it.row.id : it.group)}
        {#if it.kind === "one"}
          {@render one(it.row)}
        {:else}
          {@render pick(it.group, it.rows)}
        {/if}
      {/each}
      {#if chat.reviewUnavailable && memory.pending.length > 0}
        <div class="flex flex-wrap items-center gap-2 px-3 py-2 text-small">
          <span class="text-muted">Answer them in the Hermes CLI:</span>
          <code class="rounded bg-code-bg px-1.5 font-mono">{COMMAND}</code>
          <button type="button" class="btn btn-secondary py-0! text-small" onclick={copyCommand}>
            <PanelIcon name="copy" class="size-3" />
            {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
          </button>
        </div>
      {/if}
    </div>
  {/if}

  {@render file("Notes", "MEMORY.md", memory.notes, allNotes, () => (allNotes = !allNotes), "No notes yet.")}
  {@render file("About you", "USER.md", memory.profile, allProfile, () => (allProfile = !allProfile), "Nothing about you yet.")}
</div>

{#snippet when(p: PendingRow)}
  <span class="text-[11.5px]">
    {#if p.createdAt !== undefined}
      <span class="text-muted">{relativeTime(p.createdAt, now)} ·</span>
    {/if}
    <button type="button" class="link-btn" onclick={() => chat.openPanel(p.key)}>see the change</button>
  </span>
{/snippet}

{#snippet buttons(approveLabel: string, onApprove: (() => void) | null, rejectLabel: string, rows: PendingRow[])}
  <!-- "Use this one" approves one and rejects the rest: the approve is what shows. -->
  {@const hows = rows.map((r) => chat.reviewing.get(r.id))}
  {@const how = hows.includes("approve") ? "approve" : hows.includes("reject") ? "reject" : undefined}
  <div class="mt-1 flex flex-wrap items-center gap-1.5">
    {#if onApprove}
      <button type="button" class="btn btn-primary py-0.5! text-small" disabled={!!how} onclick={onApprove}>
        <PanelIcon name={how === "approve" ? "spin" : "check"} class="size-3.5" />
        {how === "approve" ? "Saving…" : approveLabel}
      </button>
    {/if}
    <button type="button" class="btn btn-secondary py-0.5! text-small" disabled={!!how} onclick={() => reject(rows)}>
      <PanelIcon name={how === "reject" ? "spin" : "cross"} class="size-3.5" />
      {how === "reject" ? "Rejecting…" : rejectLabel}
    </button>
  </div>
{/snippet}

{#snippet one(p: PendingRow)}
  <div class="flex gap-2.5 px-3 py-2.5">
    <PanelIcon
      name={p.action === "add" ? "plus" : p.action === "remove" ? "minus" : "swap"}
      class={["mt-0.5 size-4", p.action === "add" ? "text-success" : "text-muted"]}
    />
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <span class="flex flex-wrap items-center gap-x-1.5">
        <span class="font-semibold">{pendingHeading(p)}</span>
        {#if p.stale}
          <span class="rounded border border-warning/50 px-1.5 text-[10.5px] leading-4 text-warning">outdated</span>
        {/if}
      </span>
      {#if p.replaces}
        <span class="text-[11.5px] text-muted">{p.changed ? "It was written for" : "Now it says"}</span>
        <span class="memory-old line-clamp-4 text-small wrap-break-word">{p.replaces}</span>
      {/if}
      {#if p.action !== "remove" || !p.replaces}
        {#if p.replaces}<span class="text-[11.5px] text-muted">Change it to</span>{/if}
        <span class="line-clamp-4 text-small wrap-break-word">{p.text}</span>
      {/if}
      {@render when(p)}
      {#if p.stale}
        <span class="text-[11.5px] text-muted">{whyOutdated(p)}</span>
        {@render buttons("", null, "Reject", [p])}
      {:else}
        {@render buttons("Approve", () => approve(p), "Reject", [p])}
      {/if}
    </div>
  </div>
{/snippet}

{#snippet pick(group: string, rows: PendingRow[])}
  {@const chosenId = pickOf(group, rows)}
  {@const chosen = rows.find((r) => r.id === chosenId) ?? rows[0]}
  {@const first = rows[0]}
  <!-- All versions of one rewrite point at the same entry: outdated together. -->
  {@const dead = rows.every((r) => r.stale)}
  {#if chosen && first && dead}
    <div class="flex gap-2.5 px-3 py-2.5">
      <PanelIcon name="swap" class="mt-0.5 size-4 text-muted" />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="flex flex-wrap items-center gap-x-1.5">
          <span class="font-semibold">{pendingHeading(first)}</span>
          <span class="text-small text-muted">· {rows.length} versions</span>
          <span class="rounded border border-warning/50 px-1.5 text-[10.5px] leading-4 text-warning">outdated</span>
        </span>
        {#if first.replaces}
          <span class="text-[11.5px] text-muted">{first.changed ? "They were written for" : "Now it says"}</span>
          <span class="memory-old line-clamp-4 text-small wrap-break-word">{first.replaces}</span>
        {/if}
        <ul class="flex list-none flex-col gap-1 p-0">
          {#each rows as r (r.id)}
            <li class="border-l-2 border-border pl-2 text-small text-muted wrap-break-word">
              {r.text}
              <span class="block">{@render when(r)}</span>
            </li>
          {/each}
        </ul>
        <span class="text-[11.5px] text-muted">{whyOutdated(first)}</span>
        {@render buttons("", null, `Reject all ${rows.length}`, rows)}
      </div>
    </div>
  {:else if chosen && first}
    <div class="flex gap-2.5 px-3 py-2.5">
      <PanelIcon name="swap" class="mt-0.5 size-4 text-muted" />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="flex flex-wrap items-baseline gap-x-1.5">
          <span class="font-semibold">{pendingHeading(first)}</span>
          <span class="text-small text-muted">· {rows.length} versions, pick one</span>
        </span>
        {#if first.replaces}
          <span class="text-[11.5px] text-muted">Now it says</span>
          <span class="memory-old line-clamp-4 text-small wrap-break-word">{first.replaces}</span>
        {/if}
        <span class="text-[11.5px] text-muted">Change it to</span>
        <div role="radiogroup" aria-label="Versions of this change" class="flex flex-col gap-1.5">
          {#each rows as r (r.id)}
            <label class={["memory-choice", r.id === chosen.id && "memory-choice-on"]}>
              <input
                type="radio"
                name="{radioName}-{group}"
                value={r.id}
                checked={r.id === chosen.id}
                disabled={!!chat.reviewing.get(r.id)}
                onchange={() => picked.set(group, r.id)}
              />
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="text-small wrap-break-word">{r.text}</span>
                {@render when(r)}
              </span>
            </label>
          {/each}
        </div>
        {@render buttons(
          "Use this one",
          chosen.stale ? null : () => approve(chosen, rows.filter((r) => r.id !== chosen.id)),
          `Reject all ${rows.length}`,
          rows,
        )}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet file(title: string, name: string, f: MemoryFile, all: boolean, toggle: () => void, empty: string)}
  <h2 class="section-label">
    {title}
    <span class="aside">·</span>
    <button type="button" class="link-btn aside text-muted!" onclick={() => chat.openPanel(f.open)}>{name}</button>
  </h2>
  {#if f.entries.length === 0}
    <p class="px-0.5 text-small text-muted">{empty}</p>
  {:else}
    <div class="panel-card">
      {#each all ? f.entries : f.entries.slice(0, FIRST) as e (e.key)}
        <button type="button" class="panel-row-btn text-small" title={e.text} onclick={() => chat.openPanel(e.key)}>
          <span class="min-w-0 flex-1 truncate">{e.text.split(/\r?\n/, 1)[0]}</span>
        </button>
      {/each}
      {#if f.entries.length > FIRST}
        <button type="button" class="panel-row-btn text-small text-link!" onclick={toggle}>
          {all ? "Show fewer" : `Show all ${f.entries.length}`}
        </button>
      {/if}
    </div>
  {/if}
{/snippet}
