<script lang="ts">
  import { untrack } from "svelte";
  import type { ChatItem, ChatMeta } from "$shared/chat";
  import { chat } from "$lib/chat.svelte";
  import { markdownActions } from "$lib/delegate";
  import { buildRows } from "$lib/rows";
  import { mentionSegments } from "$lib/suggest";
  import { parseTime, relativeTime, UNTITLED } from "$lib/sessions";
  import { post } from "$lib/vscode";
  import ContextIcon from "./ContextIcon.svelte";
  import ImageThumb from "./ImageThumb.svelte";
  import HermesMark from "./HermesMark.svelte";
  import LearnedRow from "./LearnedRow.svelte";
  import Markdown from "./Markdown.svelte";
  import NoticeItem from "./NoticeItem.svelte";
  import PermissionCard from "./PermissionCard.svelte";
  import ReplyEnd from "./ReplyEnd.svelte";
  import SummaryItem from "./SummaryItem.svelte";
  import ThoughtItem from "./ThoughtItem.svelte";
  import ToolGroup from "./ToolGroup.svelte";

  let { items, meta }: { items: ChatItem[]; meta: ChatMeta } = $props();

  // A finished reply ends with its changed files and footer (mock board 23).
  const rows = $derived(buildRows(items, { ends: true, ...(meta.busy ? { openTurn: meta.turn } : {}) }));

  /** An empty chat with Hermes ready: the moment to offer the recent sessions. */
  const welcoming = $derived(items.length === 0 && meta.connection.state === "ready");
  $effect(() => {
    // Fresh each time the chat empties (New chat): a turn just finished in the
    // previous session, which moved it to the top of the list.
    if (welcoming) chat.refreshSessions();
  });
  const recent = $derived(
    welcoming ? chat.sessions.items.filter((s) => s.id !== meta.sessionId).slice(0, 3) : [],
  );

  /** Scrolling back down to within this many px of the bottom resumes following. */
  const NEAR_BOTTOM = 80;
  /** Closer than this is "at the bottom" (sub-pixel rounding, clamping). */
  const AT_BOTTOM = 2;

  // Plain variables: only touched by handlers and the observer, never rendered.
  let scroller: HTMLElement | undefined;
  let lastTop = 0;

  /** The user scrolled up to read: stop following new content. */
  let away = $state(false);
  /** The items as they were when the user scrolled away. */
  let itemsWhenAway: ChatItem[] | undefined = $state.raw();
  /** applyOps hands out a new array on every change, so a different reference
   *  means content arrived since the user scrolled away. */
  const unseen = $derived(away && items.length > 0 && items !== itemsWhenAway);

  /** The item still being streamed into, if any: last item of the busy turn. */
  const streamingId = $derived.by(() => {
    if (!meta.busy) return undefined;
    const last = items.at(-1);
    if (!last || last.turn !== meta.turn) return undefined;
    return last.kind === "assistant" || last.kind === "thought" ? last.id : undefined;
  });

  function stick(): void {
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    lastTop = scroller.scrollTop;
  }

  function onscroll(): void {
    if (!scroller) return;
    const top = scroller.scrollTop;
    const distance = scroller.scrollHeight - top - scroller.clientHeight;
    if (top < lastTop - 1 && distance > AT_BOTTOM) {
      // Any upward move pauses following, however small: with a threshold, a
      // trackpad scrolling up in small steps would be snapped back by every
      // streamed batch and could never get away. Content growing below leaves
      // scrollTop alone, and a clamp after content shrinks lands AT the
      // bottom, so neither is mistaken for the user.
      if (!away) {
        away = true;
        itemsWhenAway = items;
      }
    } else if (distance <= AT_BOTTOM || (top > lastTop && distance <= NEAR_BOTTOM)) {
      away = false;
    }
    lastTop = top;
  }

  // Effects run after the template has updated, so scrollHeight already
  // includes the new items. `away` is read untracked: scrolling back near the
  // bottom must not yank the view the last few pixels down.
  $effect(() => {
    // An emptied list (New chat) starts following again. Scrolled to the very
    // top, the shrink fires no scroll event, so onscroll could never reset it.
    if (items.length === 0) {
      away = false;
      itemsWhenAway = undefined;
      lastTop = 0;
      return;
    }
    if (!untrack(() => away)) stick();
  });

  /** The scroll container: remember it, and keep the bottom pinned when its own
   *  box changes size (the composer growing, the sidebar being resized). */
  function scrollArea(el: HTMLElement) {
    scroller = el;
    const ro = new ResizeObserver(() => {
      if (!away) stick();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      scroller = undefined;
    };
  }

  function reducedMotion(): boolean {
    return (
      document.body.classList.contains("vscode-reduce-motion") ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function jumpToLatest(): void {
    if (!scroller) return;
    away = false;
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: reducedMotion() ? "instant" : "smooth",
    });
  }

  const openLink = (href: string) => post({ type: "openLink", href });
  const openFile = (path: string, line?: number) =>
    post({ type: "openFile", path, ...(line ? { line } : {}) });
</script>

<div class="relative min-h-0 flex-1">
  {#if items.length === 0}
    <!-- Overlay, so the live region below exists (empty) before the first
         message: a region that appears together with its content is often
         not announced. -->
    <div
      class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-muted"
    >
      <HermesMark size={40} />
      {#if meta.connection.state === "noFolder"}
        <p class="mt-1">Open a folder to chat with Hermes.</p>
      {:else}
        <p class="mt-1 text-[1.25em] font-semibold text-fg">What should Hermes work on?</p>
        <p>
          In
          {#if meta.folder}
            <span class="font-medium text-fg">{meta.folder}</span>
          {:else}
            this workspace
          {/if}
        </p>
        <p class="text-small">Enter to send · Shift+Enter for a new line · hold Shift to drop files</p>
      {/if}
      {#if recent.length > 0}
        <!-- The overlay ignores the pointer (the log below it must stay
             reachable); this block takes it back. -->
        <div class="pointer-events-auto mt-5 flex w-full max-w-80 flex-col gap-0.5 text-left">
          <div class="flex items-center px-2 text-[11px] font-semibold tracking-wider uppercase">
            <span class="flex-1">Recent in this folder</span>
            <button
              type="button"
              class="cursor-pointer text-small font-normal tracking-normal text-link normal-case hover:text-link-active"
              onclick={() => chat.openSessions()}
            >
              View all
            </button>
          </div>
          {#each recent as s (s.id)}
            <button
              type="button"
              class="flex min-w-0 cursor-pointer flex-col rounded-md px-2 py-1.5 text-left hover:bg-hover"
              title={s.title ?? UNTITLED}
              onclick={() => chat.openSession(s.id)}
            >
              <span class="truncate text-fg">{s.title ?? UNTITLED}</span>
              <span class="text-small">{relativeTime(parseTime(s.updatedAt), Date.now())}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if meta.connection.state !== "noFolder"}
        <div class="pointer-events-auto mt-5 w-full max-w-80"><LearnedRow /></div>
      {/if}
    </div>
  {/if}

  <div class="h-full overflow-y-auto" {onscroll} {@attach scrollArea}>
    <div
      class="mx-auto flex w-full max-w-4xl flex-col gap-2.5 px-4 py-4"
      role="log"
      aria-live="polite"
      aria-label="Conversation with Hermes"
      {@attach markdownActions(openLink, openFile)}
    >
      {#each rows as row (row.key)}
        {#if row.kind === "end"}
          <ReplyEnd turn={row.turn} {items} {meta} />
        {:else}
        {#if row.head}
          <div class="mt-1.5 flex items-center gap-2 text-small first:mt-0">
            <HermesMark size={18} />
            <span class="font-semibold text-fg">Hermes</span>
          </div>
        {/if}
        {#if row.kind === "tools"}
          <ToolGroup tools={row.tools} />
        {:else if row.item.kind === "user"}
          {@const item = row.item}
          <div class="mt-3 ml-10 flex flex-col items-end gap-0.5 self-end first:mt-0">
            {#if item.attachments?.length}
              <div class={["flex flex-wrap justify-end gap-1 pb-0.5", item.notSent && "opacity-60"]}>
                {#each item.attachments as a, i (i)}
                  {#if a.kind === "image" && a.id}
                    <button
                      type="button"
                      class="ctx-chip ctx-chip-view pr-[7px] pl-[3px]"
                      aria-label="View {a.label}"
                      title="Click to view"
                      onclick={() => chat.openImage(a)}
                    >
                      <ImageThumb id={a.id} />
                      <span class="truncate">{a.label}</span>
                      {#if a.size}<span class="shrink-0 tabular-nums opacity-80">{a.size}</span>{/if}
                    </button>
                  {:else}
                    <span class={["ctx-chip pr-[7px]", a.kind === "skill" ? "ctx-chip-skill" : "text-muted"]}>
                      <ContextIcon kind={a.kind} class="size-3" />
                      <span class="truncate">{a.label}</span>
                    </span>
                  {/if}
                {/each}
              </div>
            {/if}
            <div
              class={[
                "max-w-full rounded-[12px_12px_3px_12px] border border-user-border bg-user-bubble px-3 py-2 wrap-break-word whitespace-pre-wrap",
                item.notSent && "opacity-60",
              ]}
            >
              {#each mentionSegments(item.text, chat.panels?.capabilities.skills) as s, i (i)}{#if s.mention}<span class="at-mention">{s.text}</span>{:else}{s.text}{/if}{/each}
            </div>
            {#if item.notSent}
              <span class="text-small text-muted">not sent</span>
            {:else if item.steered}
              <span class="text-small text-muted">sent while Hermes worked · Hermes reads it at its next step</span>
            {/if}
          </div>
        {:else if row.item.kind === "assistant"}
          <div aria-busy={row.item.id === streamingId || undefined}>
            <Markdown text={row.item.text} streaming={row.item.id === streamingId} />
          </div>
        {:else if row.item.kind === "thought"}
          <div aria-busy={row.item.id === streamingId || undefined}>
            <ThoughtItem text={row.item.text} active={row.item.id === streamingId} />
          </div>
        {:else if row.item.kind === "summary"}
          <SummaryItem text={row.item.text} />
        {:else if row.item.kind === "notice"}
          <NoticeItem level={row.item.level} text={row.item.text} action={row.item.action} />
        {:else if row.item.kind === "permission"}
          <PermissionCard item={row.item} />
        {/if}
        {/if}
      {/each}
    </div>
  </div>

  {#if unseen}
    <button
      type="button"
      class="btn btn-float absolute bottom-2 left-1/2 -translate-x-1/2"
      onclick={jumpToLatest}
    >
      <span aria-hidden="true">↓</span> Jump to latest
    </button>
  {/if}
</div>
