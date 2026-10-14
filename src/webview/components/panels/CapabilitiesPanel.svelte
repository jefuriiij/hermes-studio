<script lang="ts">
  import type { CapabilitiesView, SkillSource } from "$shared/panels";
  import { chat } from "$lib/chat.svelte";
  import { filterSkills, SOURCES } from "$lib/panels";
  import HubBrowser from "./HubBrowser.svelte";
  import PanelIcon, { type IconName } from "./PanelIcon.svelte";

  let { capabilities }: { capabilities: CapabilitiesView } = $props();

  /** Installed skills, or "Get more" from the Skills Hub (mock board 28). */
  let view = $state<"installed" | "more">("installed");
  const installedNames = $derived(new Set(capabilities.skills.map((s) => s.name)));

  const skills = $derived(capabilities.skills);
  const count = (s: SkillSource) => skills.filter((x) => x.source === s).length;
  /** Only sources that have skills get a chip. */
  const chips = $derived(SOURCES.filter((s) => count(s.id) > 0));

  // Opens on what Hermes learned itself, when it has; the user's pick wins after.
  let picked = $state<SkillSource | "all" | null>(null);
  const source = $derived(
    picked ?? (skills.some((x) => x.source === "learned") ? "learned" : "all"),
  );
  let query = $state("");
  const shown = $derived(filterSkills(skills, source, query));

  /** Rows before "Show all" (a query shows every match). */
  const FIRST = 8;
  let all = $state(false);
  const rows = $derived(all || query.trim() ? shown : shown.slice(0, FIRST));

  const ICON: Record<SkillSource, IconName> = {
    learned: "sparkle",
    hub: "hub",
    local: "person",
    builtin: "package",
  };
  const filterId = $props.id();
</script>

<div class="flex flex-col gap-3 p-3.5">
  <div class="flex items-center gap-2">
    <div class="seg" role="group" aria-label="Skills">
      <button type="button" aria-pressed={view === "installed"} onclick={() => (view = "installed")}>
        Installed · {skills.length}
      </button>
      <button type="button" aria-pressed={view === "more"} onclick={() => (view = "more")}>Get more</button>
    </div>
    <span class="flex-1"></span>
    <button
      type="button"
      class="icon-btn"
      aria-label="Refresh: read Hermes's skills again"
      title="Read Hermes's skills again"
      disabled={chat.refreshing}
      onclick={() => chat.refreshPanels()}
    >
      <PanelIcon name={chat.refreshing ? "spin" : "refresh"} class="size-4" />
    </button>
  </div>

  {#if view === "more"}
    <HubBrowser installed={installedNames} />
  {:else}
  <div class="relative">
    <PanelIcon name="search" class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
    <label for={filterId} class="sr-only">Filter skills</label>
    <input
      id={filterId}
      bind:value={query}
      type="text"
      placeholder="Filter {skills.length} skills"
      class="h-7 w-full rounded-md border border-input-border bg-input py-0 pr-2.5 pl-8 text-input-fg outline-none placeholder:text-placeholder focus:outline-1 focus:-outline-offset-1 focus:outline-focus"
    />
  </div>

  <div class="flex flex-wrap gap-1.5" role="group" aria-label="Where the skills come from">
    {#each [{ id: "all" as const, label: "All" }, ...chips] as c (c.id)}
      {@const on = source === c.id}
      <button
        type="button"
        aria-pressed={on}
        class={[
          "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-small whitespace-nowrap",
          on
            ? "border-focus bg-selected text-selected-fg"
            : "border-input-border bg-transparent hover:bg-toolbar-hover",
        ]}
        onclick={() => {
          picked = c.id;
          all = false;
        }}
      >
        {#if c.id === "learned"}<PanelIcon name="learning" class="size-3" />{/if}
        {c.label}
        <span class={["tabular-nums", on ? "opacity-80" : "text-muted"]}>
          {c.id === "all" ? skills.length : count(c.id)}
        </span>
      </button>
    {/each}
  </div>

  {#if shown.length === 0}
    <p class="px-0.5 text-small text-muted">
      {query.trim() ? `No skills match “${query.trim()}”.` : "No skills here."}
    </p>
  {:else}
    <div class="panel-card">
      {#each rows as s (s.key)}
        <button type="button" class="panel-row-btn" title="Open its SKILL.md" onclick={() => chat.openPanel(s.key)}>
          <PanelIcon
            name={ICON[s.source]}
            class={["mt-0.5 size-4", s.source === "learned" ? "text-hermes" : "text-muted"]}
          />
          <span class="flex min-w-0 flex-col gap-px">
            <span class="flex min-w-0 items-baseline gap-2">
              <!-- The name wins the space; the category shortens first. -->
              <span class="max-w-full shrink-0 truncate font-mono">{s.name}</span>
              {#if s.category}<span class="min-w-0 truncate text-[11.5px] text-muted">{s.category}</span>{/if}
            </span>
            {#if s.description}
              <span class="line-clamp-2 text-small text-muted">{s.description}</span>
            {/if}
          </span>
        </button>
      {/each}
      {#if !query.trim() && shown.length > FIRST}
        <button type="button" class="panel-row-btn text-small text-link!" onclick={() => (all = !all)}>
          {all ? "Show fewer" : `Show all ${shown.length}`}
        </button>
      {/if}
    </div>
  {/if}

  <h2 class="section-label">
    Connectors (MCP) <span class="aside">· {capabilities.mcp.length}</span>
  </h2>
  {#if capabilities.mcp.length === 0}
    <p class="px-0.5 text-small text-muted">None set up in Hermes's config.yaml.</p>
  {:else}
    <div class="panel-card">
      {#each capabilities.mcp as m (m.name)}
        <div class="flex items-center gap-2 px-3 py-2 text-small">
          <span
            class={["size-[7px] shrink-0 rounded-full border border-hc", m.enabled ? "bg-success" : "bg-muted"]}
            aria-hidden="true"
          ></span>
          <span class="min-w-0 truncate font-mono">{m.name}</span>
          <span class="ml-auto shrink-0 text-muted">{m.transport} · {m.enabled ? "on" : "off"}</span>
        </div>
      {/each}
      <div class="px-3 py-1.5 text-small text-muted">From config.yaml. Only the names are read.</div>
    </div>
  {/if}

  <h2 class="section-label">Plugins</h2>
  {#if capabilities.plugins.length === 0}
    <p class="px-0.5 text-small text-muted">None added. Hermes's own bundled plugins are not listed.</p>
  {:else}
    <div class="panel-card">
      {#each capabilities.plugins as p (p.name)}
        <div class="flex items-center gap-2 px-3 py-2 text-small">
          <span class="min-w-0 truncate font-mono">{p.name}</span>
          <span class="ml-auto shrink-0 text-muted">{p.enabled ? "on" : "off"}</span>
        </div>
      {/each}
    </div>
  {/if}
  {/if}
</div>
