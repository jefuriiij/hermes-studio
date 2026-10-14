<script lang="ts">
  import type { ChatMeta } from "$shared/chat";
  import { chat } from "$lib/chat.svelte";
  import { describeConnection, type Tone } from "$lib/format";
  import { post } from "$lib/vscode";

  /** `waiting`: an approval card is waiting for the user. */
  let { meta, waiting = false }: { meta: ChatMeta; waiting?: boolean } = $props();

  const view = $derived(describeConnection(meta.connection, meta.busy));

  const DOT: Record<Tone, string> = {
    muted: "bg-muted",
    busy: "bg-progress animate-pulse",
    ok: "bg-success",
    warn: "bg-warning",
    error: "bg-error",
  };

  const statusTitle = $derived.by(() => {
    const parts: string[] = [];
    if (meta.connection.state === "starting" && meta.connection.detail) {
      parts.push(meta.connection.detail);
    }
    if (meta.agentVersion) parts.push(`Hermes ${meta.agentVersion}`);
    return parts.join(" · ") || undefined;
  });
</script>

<header class="shrink-0 border-b border-border px-4 py-2.5">
  <div class="flex min-w-0 items-center gap-2.5">
    <!-- The title is also the way to the other sessions of this folder. -->
    <button
      type="button"
      class="-mx-1.5 -my-1 flex min-w-0 flex-1 cursor-pointer flex-col rounded-md px-1.5 py-1 text-left hover:bg-hover"
      title={meta.title ? `${meta.title} — show sessions` : "Show sessions"}
      aria-label="Show sessions in this folder"
      aria-haspopup="dialog"
      aria-expanded={chat.sessionsOpen}
      data-menu-trigger
      onclick={() => chat.toggleSessions()}
    >
      <span class="flex max-w-full min-w-0 items-center gap-1">
        <span class="truncate font-semibold">{meta.title ?? "New chat"}</span>
        <svg class="size-3.5 shrink-0 text-muted" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <!-- Before the first `init` the folder is simply not known yet: say
           "No folder open" only when the host says so. -->
      {#if meta.folder || meta.connection.state === "noFolder"}
        <span class="truncate text-small text-muted">{meta.folder ?? "No folder open"}</span>
      {/if}
    </button>
    <!-- Working gets a filled pill: it is the one state that changes while you
         watch. Every other state is a dot and a word. Waiting on an approval
         overrides Working: Hermes is blocked on YOU. -->
    {#if waiting && meta.busy}
      <span class="pill-busy pill-warn shrink-0" role="status">
        <span class="size-2 shrink-0 animate-pulse rounded-full bg-warning" aria-hidden="true"></span>
        Needs you
      </span>
    {:else}
      <span
        class={view.tone === "busy" ? "pill-busy shrink-0" : "flex shrink-0 items-center gap-1.5 text-small text-muted"}
        role="status"
        title={statusTitle}
      >
        <span class={["size-2 shrink-0 rounded-full border border-hc", DOT[view.tone]]} aria-hidden="true"
        ></span>
        {view.text}
      </span>
    {/if}
  </div>

  {#if view.message || view.buttons.length > 0}
    <div class="mt-2 flex flex-col gap-1.5">
      {#if view.message}
        <p class="line-clamp-3 text-small wrap-break-word text-muted" title={view.message}>
          {view.message}
        </p>
      {/if}
      {#if view.buttons.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each view.buttons as b (b.action)}
            <button
              type="button"
              class={["btn", b.primary ? "btn-primary" : "btn-secondary"]}
              onclick={() => post({ type: "action", action: b.action })}
            >
              {b.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</header>
