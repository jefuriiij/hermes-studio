<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import type { ToolStatus } from "$shared/chat";
  import { countTools, describeCounts, parseToolTitle, type ToolEntry } from "$lib/rows";
  import { post } from "$lib/vscode";
  import DiffBlock from "./DiffBlock.svelte";

  let { tools }: { tools: ToolEntry[] } = $props();

  const counts = $derived(countTools(tools));
  const summary = $derived(describeCounts(counts));

  /** `null` until the user clicks the header. Until then the card is open
   *  exactly while a step runs, so a finished turn folds itself away. */
  let manual: boolean | null = $state(null);
  const open = $derived(manual ?? counts.running > 0);
  const bodyId = $props.id();

  /** Steps opened to show their output, diff or files. */
  const expanded = new SvelteSet<string>();
  function toggleStep(id: string): void {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
  }

  const STATUS_TEXT: Record<ToolStatus, string> = {
    running: "running",
    completed: "done",
    failed: "failed",
  };

  // Stroke icons on a 16-unit grid, one per ACP tool kind.
  const ICONS: Record<string, string> = {
    read: "M4 2h5l3 3v9H4zM9 2v3h3",
    edit: "M3 13l1-3 7-7 2 2-7 7z",
    delete: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
    move: "M2.5 8h10M9 4.5L12.5 8 9 11.5",
    search: "M11 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM10 10l3.5 3.5",
    execute: "M2 3.5h12v9H2zM5 7l2 1.5L5 10M8.5 10.5H11",
    think: "M6 12.5h4M6.5 14.5h3M8 2a4 4 0 0 0-2.5 7.1c.6.5 1 1.2 1 2v.4h3v-.4c0-.8.4-1.5 1-2A4 4 0 0 0 8 2z",
    fetch: "M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0zM2.5 8h11M8 2.5c1.6 1.6 2.3 3.5 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 6 5.7 8s.7 3.9 2.3 5.5",
    other: "M10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2",
  };
  /** Paths, commands and queries read better in the editor font. */
  const MONO = new Set(["read", "edit", "delete", "move", "search", "execute"]);
</script>

{#snippet status(s: ToolStatus)}
  <span class="flex size-4 shrink-0 items-center justify-center">
    {#if s === "running"}
      <!-- Stops in place under reduced motion (app.css) and still reads as busy. -->
      <span
        class="size-2.5 animate-spin rounded-full border-[1.5px] border-link border-t-transparent"
        aria-hidden="true"
      ></span>
    {:else if s === "completed"}
      <svg class="size-3.5 text-success" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
    {:else}
      <svg class="size-3.5 text-error" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
    {/if}
  </span>
{/snippet}

<div class="card text-small">
  <button
    type="button"
    class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover"
    aria-expanded={open}
    aria-controls={bodyId}
    onclick={() => (manual = !open)}
  >
    <svg
      class={["size-3 shrink-0 text-muted transition-transform", open && "rotate-90"]}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" />
    </svg>
    <span class="shrink-0 font-semibold">{tools.length} {tools.length === 1 ? "step" : "steps"}</span>
    <span class="min-w-0 flex-1 truncate text-muted">· {summary}</span>
    {@render status(counts.running ? "running" : counts.failed ? "failed" : "completed")}
  </button>

  {#if open}
    <ul id={bodyId} class="flex flex-col border-t border-border py-1">
      {#each tools as t (t.id)}
        {@const title = parseToolTitle(t.title)}
        {@const kind = t.toolKind && ICONS[t.toolKind] ? t.toolKind : "other"}
        {@const hasDetails = !!(t.output || t.diff || t.locations?.length)}
        {@const isOpen = expanded.has(t.id)}
        <li class="flex min-w-0 flex-col">
          {#snippet stepRow()}
            <svg class="size-3.5 shrink-0 text-muted" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d={ICONS[kind]}
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {#if title.label}
              <span class="shrink-0 text-muted">{title.label}</span>
            {/if}
            <span class={["min-w-0 flex-1 truncate", MONO.has(kind) && "font-mono"]}>{title.detail}</span>
            {#if t.diff}
              <span class="shrink-0 tabular-nums">
                <span class="text-success">+{t.diff.added}</span>
                <span class="text-error">−{t.diff.removed}</span>
              </span>
            {/if}
            {#if hasDetails}
              <svg
                class={["size-2.5 shrink-0 text-muted transition-transform", isOpen && "rotate-90"]}
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" />
              </svg>
            {/if}
            {@render status(t.status)}
            <span class="sr-only">{STATUS_TEXT[t.status]}</span>
          {/snippet}
          <!-- A step with something to show opens on click; one without is plain text. -->
          {#if hasDetails}
            <button
              type="button"
              class="flex w-full min-w-0 cursor-pointer items-center gap-2 py-1 pr-2.5 pl-3 text-left hover:bg-hover"
              title={t.title}
              aria-expanded={isOpen}
              onclick={() => toggleStep(t.id)}
            >
              {@render stepRow()}
            </button>
          {:else}
            <div class="flex min-w-0 items-center gap-2 py-1 pr-2.5 pl-3" title={t.title}>
              {@render stepRow()}
            </div>
          {/if}
          {#if isOpen}
            <div class="flex flex-col gap-1.5 pt-0.5 pr-2.5 pb-2 pl-8">
              {#if t.locations?.length}
                <div class="flex flex-wrap gap-x-3 gap-y-0.5">
                  {#each t.locations as loc (loc.path)}
                    <button
                      type="button"
                      class="min-w-0 cursor-pointer truncate font-mono text-link hover:underline"
                      title="Open {loc.path}{loc.line ? `:${loc.line}` : ''}"
                      onclick={() => post({ type: "openFile", path: loc.path, ...(loc.line ? { line: loc.line } : {}) })}
                    >
                      {loc.path}{loc.line ? `:${loc.line}` : ""}
                    </button>
                  {/each}
                </div>
              {/if}
              {#if t.diff}
                <DiffBlock diff={t.diff} onopen={() => post({ type: "openDiff", id: t.id })} />
              {/if}
              {#if t.output}
                <!-- Tool output is data: plain text, never markdown. -->
                <pre
                  class="m-0 max-h-60 overflow-auto rounded-md bg-code-bg px-2.5 py-1.5 font-mono text-[12px] leading-normal wrap-break-word whitespace-pre-wrap">{t.output}</pre>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
