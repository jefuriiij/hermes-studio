<script lang="ts">
  import type { ChatMeta } from "$shared/chat";
  import { chat } from "$lib/chat.svelte";
  import { stepIndex } from "$lib/models";
  import { outsideClick } from "$lib/outside";
  import {
    filterSessions,
    isRunning,
    parseTime,
    shortAgo,
    UNTITLED,
    withBackground,
  } from "$lib/sessions";

  let { meta }: { meta: ChatMeta } = $props();

  let query = $state("");
  /** Re-read once a minute so "12m" keeps moving while the list is open. */
  let now = $state(Date.now());
  $effect(() => {
    const timer = window.setInterval(() => (now = Date.now()), 60_000);
    return () => window.clearInterval(timer);
  });

  const list = $derived(chat.sessions);
  // Chats working in the background sit on top, marked, even before Hermes lists them.
  const rows = $derived(withBackground(list.items, chat.background));
  const shown = $derived(filterSessions(rows, query));
  const working = $derived(chat.background.filter((b) => isRunning(b.state)).length);
  // Opens on the current session (or the first); typing moves to the first match.
  let active = $state(0);
  let placed = false;
  $effect(() => {
    // Once the first page lands, start on the current session (only then:
    // a later page must not move the highlight under the user's keys).
    if (placed || list.items.length === 0) return;
    placed = true;
    const i = rows.findIndex((s) => s.id === meta.sessionId);
    if (i >= 0 && !query) active = i;
  });
  const listId = $props.id();
  const optionId = (i: number) => `${listId}-${i}`;

  let listEl: HTMLElement | undefined;
  $effect(() => {
    if (active < 0 || !listEl) return;
    listEl.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: "nearest" });
  });

  function open(i: number): void {
    const s = shown[i];
    if (s) chat.openSession(s.id);
  }

  // Rename in place / confirm a delete: one row at a time.
  let editing = $state<{ id: string; draft: string } | null>(null);
  let confirming = $state<string | null>(null);
  let searchEl: HTMLInputElement | undefined = $state();
  const MAX_TITLE = 100;

  /** A chat still working (or waiting on you) keeps its name until it is
   *  done; the chat on screen cannot be deleted while Hermes works in it. */
  function canChange(s: (typeof shown)[number], action: "rename" | "delete"): boolean {
    if (isRunning(s.state)) return false;
    return !(action === "delete" && s.id === meta.sessionId && meta.busy);
  }

  function startRename(i: number): void {
    const s = shown[i];
    if (!s || !canChange(s, "rename")) return;
    confirming = null;
    editing = { id: s.id, draft: s.title ?? "" };
  }

  function startDelete(i: number): void {
    const s = shown[i];
    if (!s || !canChange(s, "delete")) return;
    editing = null;
    confirming = s.id;
  }

  function saveRename(): void {
    const e = editing;
    if (!e) return;
    const title = e.draft.trim();
    const before = shown.find((s) => s.id === e.id)?.title ?? "";
    if (title && title !== before) chat.renameSession(e.id, title);
    editing = null;
    searchEl?.focus();
  }

  function doDelete(): void {
    if (confirming) chat.deleteSession(confirming);
    confirming = null;
    searchEl?.focus();
  }

  function cancelChange(): void {
    editing = null;
    confirming = null;
    searchEl?.focus();
  }

  function onRenameKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      saveRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // cancel the rename, keep the pop-up
      cancelChange();
    }
  }

  function onConfirmKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelChange();
    }
  }

  function onkeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        active = stepIndex(active, e.key === "ArrowDown" ? 1 : -1, shown.length);
        break;
      case "Enter":
        e.preventDefault();
        open(active);
        break;
      case "F2":
        e.preventDefault();
        startRename(active);
        break;
      case "Delete":
        // With text in the search box, Delete edits the text.
        if (query) return;
        e.preventDefault();
        startDelete(active);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation(); // not the composer's Esc-to-stop
        // First Esc clears the search, the next one closes.
        if (query) query = "";
        else chat.closeSessions("escape");
        break;
      case "Tab":
        chat.closeSessions("outside");
        break;
    }
  }
</script>

<div
  role="dialog"
  aria-label="Sessions in {meta.folder ?? 'this folder'}"
  class="absolute top-1 right-2 z-30 flex max-h-[min(70vh,480px)] w-[min(400px,calc(100%-16px))] flex-col gap-1.5 rounded-[10px] border border-widget-border bg-widget p-2 shadow-lg shadow-shadow"
  {@attach outsideClick(() => chat.closeSessions("outside"))}
>
  <div class="relative shrink-0">
    <svg class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM10 10l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
    <input
      bind:this={searchEl}
      {@attach (el) => el.focus()}
      bind:value={query}
      oninput={() => (active = 0)}
      {onkeydown}
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls={listId}
      aria-activedescendant={shown.length > 0 ? optionId(active) : undefined}
      aria-label="Search sessions"
      placeholder="Search sessions…"
      class="h-7.5 w-full rounded-md border border-input-border bg-input py-0 pr-2.5 pl-8 text-input-fg outline-none placeholder:text-placeholder focus:outline-1 focus:-outline-offset-1 focus:outline-focus"
    />
  </div>

  <div id={listId} role="listbox" aria-label="Sessions" class="min-h-0 flex-1 overflow-y-auto" bind:this={listEl}>
    {#if list.error}
      <div class="flex flex-col items-start gap-2 px-2.5 py-2 text-small">
        <p class="wrap-break-word text-error">Could not load the sessions: {list.error}</p>
        <button type="button" class="btn btn-secondary" onclick={() => chat.refreshSessions()}>Retry</button>
      </div>
    {:else if rows.length === 0}
      <p class="px-2.5 py-2 text-small text-muted">
        {list.loading ? "Loading sessions…" : "No saved sessions in this folder yet."}
      </p>
    {:else if shown.length === 0}
      <p class="px-2.5 py-2 text-small text-muted">No sessions match “{query}”.</p>
    {/if}
    {#each shown as s, i (s.id)}
      {@const current = s.id === meta.sessionId}
      {#if editing?.id === s.id}
        <div class="flex flex-col gap-1 rounded-md bg-hover px-1 pt-1 pb-1.5">
          <input
            {@attach (el) => {
              el.focus();
              el.select();
            }}
            bind:value={editing.draft}
            onkeydown={onRenameKey}
            maxlength={MAX_TITLE}
            aria-label="New name for this session"
            class="h-7 w-full rounded-[5px] border border-focus bg-input px-2 text-input-fg outline-none"
          />
          <div class="flex items-center gap-2 px-0.5">
            <span class="flex-1 text-[11px] text-muted">Enter to save · Esc to cancel</span>
            <button type="button" class="btn btn-secondary" onclick={cancelChange}>Cancel</button>
            <button type="button" class="btn btn-primary" onclick={saveRename}>Save</button>
          </div>
        </div>
      {:else if confirming === s.id}
        <div
          role="alertdialog"
          aria-label="Delete this session?"
          tabindex="-1"
          class="flex flex-col gap-1.5 rounded-md border border-error/60 bg-error/10 px-2.5 py-2"
          onkeydown={onConfirmKey}
        >
          <span class="wrap-break-word">Delete “{s.title ?? UNTITLED}”?</span>
          <span class="text-small text-muted">Hermes deletes the session and all its messages. This cannot be undone.</span>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn btn-secondary"
              onclick={cancelChange}
              {@attach (el) => {
                queueMicrotask(() => el.focus());
              }}
            >
              Cancel
            </button>
            <button type="button" class="btn btn-danger" onclick={doDelete}>Delete</button>
          </div>
        </div>
      {:else}
      <!-- Options, not buttons: focus stays in the search box (combobox
           pattern); a click opens, the pointer moves the highlight. -->
      <div
        id={optionId(i)}
        role="option"
        tabindex="-1"
        aria-selected={i === active}
        aria-current={current ? "true" : undefined}
        class={[
          "flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5",
          i === active ? "bg-selected text-selected-fg" : "",
          // High-contrast themes define no selection fill: outline the current one.
          current && "font-semibold outline-1 -outline-offset-1 outline-hc-active",
        ]}
        title={s.title ?? UNTITLED}
        onpointermove={() => (active = i)}
        onclick={() => open(i)}
        onkeydown={() => undefined}
      >
        <span class="min-w-0 flex-1 truncate">{s.title ?? UNTITLED}</span>
        {#if s.state === "waiting"}
          <!-- Waiting on YOU: the warning colour, as the header's "Needs you". -->
          <span class="flex shrink-0 items-center gap-1.5 text-small text-warning">
            <span class="size-[7px] rounded-full border border-hc bg-warning" aria-hidden="true"></span>
            needs you
          </span>
        {:else if s.state === "working"}
          <span class={["flex shrink-0 items-center gap-1.5 text-small", i === active ? "" : "text-link"]}>
            <svg class="size-3 animate-spin" viewBox="0 0 16 16" fill="none" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
              <circle cx="8" cy="8" r="5" stroke="currentColor" opacity="0.3" />
              <path d="M8 3a5 5 0 0 1 5 5" stroke="currentColor" />
            </svg>
            working
          </span>
        {:else if (s.state === "done" || s.state === "stopped") && i !== active}
          <!-- Ended while you were not looking, and not looked at since. -->
          <span
            class={[
              "flex shrink-0 items-center gap-1.5 text-small",
              s.state === "done" ? "text-success" : "text-warning",
            ]}
          >
            <span
              class={[
                "size-[7px] rounded-full border border-hc",
                s.state === "done" ? "bg-success" : "bg-warning",
              ]}
              aria-hidden="true"
            ></span>
            {s.state === "done" ? "finished" : "stopped"}
          </span>
        {:else if i === active && canChange(s, "rename")}
          <!-- The highlighted row's actions (the pointer or the keys: F2, Del).
               Not in the Tab order: focus stays in the search box. -->
          <span class="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              tabindex="-1"
              class="row-act"
              aria-label="Rename {s.title ?? UNTITLED}"
              title="Rename (F2)"
              onclick={(e) => {
                e.stopPropagation();
                startRename(i);
              }}
            >
              <svg class="size-3.5" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 13l1-3 7-7 2 2-7 7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
              </svg>
            </button>
            {#if canChange(s, "delete")}
              <button
                type="button"
                tabindex="-1"
                class="row-act"
                aria-label="Delete {s.title ?? UNTITLED}"
                title="Delete (Del)"
                onclick={(e) => {
                  e.stopPropagation();
                  startDelete(i);
                }}
              >
                <svg class="size-3.5" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5M7 7v4M9 7v4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            {/if}
          </span>
        {:else}
          <span class={["shrink-0 text-small tabular-nums", i === active ? "opacity-80" : "text-muted"]}>
            {current ? "now" : shortAgo(parseTime(s.updatedAt), now)}
          </span>
        {/if}
      </div>
      {/if}
    {/each}
  </div>

  {#if chat.sessionAction}
    <p
      class={["shrink-0 rounded px-2 py-1 text-small", chat.sessionAction.ok ? "bg-hover" : "text-error"]}
      aria-live="polite"
    >
      {chat.sessionAction.message}
    </p>
  {/if}

  <div class="flex shrink-0 items-center gap-2 border-t border-border px-1 pt-1.5">
    {#if list.nextCursor}
      <button
        type="button"
        class="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-small whitespace-nowrap text-link hover:text-link-active disabled:cursor-default disabled:opacity-60"
        disabled={list.loading}
        onclick={() => chat.moreSessions()}
      >
        {list.loading ? "Loading…" : "Show more"}
      </button>
    {/if}
    {#if working > 0}
      <span class="shrink-0 px-1.5 text-small whitespace-nowrap text-muted">{working} working in the background</span>
    {/if}
    {#if working === 0}
      <span class="shrink-0 px-1 text-[11px] whitespace-nowrap text-muted">F2 rename · Del delete</span>
    {/if}
    <span class="ml-auto truncate text-small text-muted">Sessions in {meta.folder ?? "this folder"}</span>
  </div>
</div>
