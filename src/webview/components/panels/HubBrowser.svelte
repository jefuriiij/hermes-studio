<script lang="ts">
  import type { HubSkill } from "$shared/panels";
  import { chat } from "$lib/chat.svelte";
  import { TRUST_LABEL } from "$lib/panels";
  import PanelIcon from "./PanelIcon.svelte";

  // "Get more" skills (mock board 28): Hermes's own skills first, a search of
  // the whole Skills Hub, and Install — Hermes fetches, scans and installs.
  let { installed }: { installed: ReadonlySet<string> } = $props();

  let query = $state("");
  let official = $state(true);
  let timer: number | undefined;

  /** Search as you type (a pause first), and right away for a chip. */
  function search(now = false): void {
    window.clearTimeout(timer);
    const run = () => chat.searchHub(query, official);
    if (now) run();
    else timer = window.setTimeout(run, 350);
  }
  // The first look: Hermes's official skills.
  $effect(() => {
    if (!chat.hub.asked) chat.searchHub("", true);
  });

  const TRUST_TONE = { official: "text-link", trusted: "text-success", community: "text-muted" } as const;
  /** "github · anthropics/skills": where it comes from, without the skill itself. */
  const origin = (s: HubSkill) => {
    const parts = s.identifier.split("/");
    const repo = s.source === "official" ? "" : parts.slice(s.source === "skills.sh" ? 1 : 0, -1).slice(0, 2).join("/");
    return repo ? `${s.source} · ${repo}` : s.source;
  };
  const inputId = $props.id();
</script>

<div class="flex flex-col gap-3">
  <div class="relative">
    <PanelIcon name="search" class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
    <label for={inputId} class="sr-only">Search the Skills Hub</label>
    <input
      id={inputId}
      bind:value={query}
      oninput={() => search()}
      onkeydown={(e) => e.key === "Enter" && search(true)}
      type="search"
      maxlength="100"
      placeholder="Search the Skills Hub…"
      class="h-7 w-full rounded-md border border-input-border bg-input py-0 pr-2.5 pl-8 text-input-fg outline-none placeholder:text-placeholder focus:outline-1 focus:-outline-offset-1 focus:outline-focus"
    />
  </div>

  <div class="flex flex-wrap gap-1.5" role="group" aria-label="Where to look">
    {#each [{ on: true, label: "★ Official" }, { on: false, label: "All sources" }] as c (c.label)}
      <button
        type="button"
        aria-pressed={official === c.on}
        class={[
          "inline-flex h-6 cursor-pointer items-center rounded-full border px-2.5 text-small whitespace-nowrap",
          official === c.on
            ? "border-focus bg-selected text-selected-fg"
            : "border-input-border bg-transparent hover:bg-toolbar-hover",
        ]}
        onclick={() => {
          official = c.on;
          search(true);
        }}
      >
        {c.label}
      </button>
    {/each}
  </div>

  <h2 class="section-label">
    {query.trim() ? `Results · “${query.trim()}”` : official ? "Official skills from Nous Research" : "Search all sources"}
    {#if chat.hub.loading}<PanelIcon name="spin" class="size-3" />{/if}
  </h2>

  {#if chat.hub.error}
    <p class="px-0.5 text-small text-error">{chat.hub.error}</p>
  {:else if !query.trim() && !official}
    <p class="px-0.5 text-small text-muted">Type what the skill should do, for example “pdf” or “testing”.</p>
  {:else if chat.hub.items.length === 0 && !chat.hub.loading}
    <p class="px-0.5 text-small text-muted">No skills found.</p>
  {:else if chat.hub.items.length > 0}
    <div class="panel-card" aria-busy={chat.hub.loading}>
      {#each chat.hub.items as s (s.identifier)}
        {@const job = chat.installs.get(s.identifier)}
        {@const has = installed.has(s.name) || job?.state === "installed"}
        <div class="flex gap-2.5 px-3 py-2.5">
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span class="min-w-0 truncate font-mono font-semibold">{s.name}</span>
              <span class={["trust", TRUST_TONE[s.trust]]}>{TRUST_LABEL[s.trust]}</span>
              <span class="min-w-0 truncate text-[11.5px] text-muted" title={s.identifier}>{origin(s)}</span>
            </span>
            {#if s.description}
              <span class="line-clamp-2 text-small text-muted">{s.description}</span>
            {/if}
            {#if job?.state === "installing"}
              <span class="flex items-center gap-1 text-[11.5px] text-link" role="status">
                <PanelIcon name="shield" class="size-3" /> Hermes is checking it for safety…
              </span>
            {:else if job?.state === "installed"}
              <span class="text-[11.5px] text-muted" role="status">Hermes can use it from your next new chat.</span>
            {:else if job?.state === "failed"}
              <span class="flex items-start gap-1 text-[11.5px] text-error" role="status">
                <PanelIcon name="shield" class="mt-0.5 size-3" /><span class="min-w-0 wrap-break-word">{job.message}</span>
              </span>
            {/if}
          </div>
          <div class="shrink-0 pt-px">
            {#if has}
              <span class="inline-flex items-center gap-1 text-small text-success">
                <PanelIcon name="check" class="size-3.5" /> Installed
              </span>
            {:else}
              <button
                type="button"
                class="btn btn-secondary py-0.5! text-small"
                disabled={job?.state === "installing"}
                aria-label="Install {s.name}"
                onclick={() => chat.installSkill(s.identifier)}
              >
                {#if job?.state === "installing"}<PanelIcon name="spin" class="size-3.5" /> Installing{:else}Install{/if}
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
    <p class="px-0.5 text-[11.5px] text-muted">
      Hermes checks every skill for risky code before it installs it. New skills work from your next new chat.
    </p>
  {/if}
</div>
