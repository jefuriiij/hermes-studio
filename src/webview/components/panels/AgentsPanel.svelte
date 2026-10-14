<script lang="ts">
  import type { AgentRun, AgentsView } from "$shared/panels";
  import { durationLabel, relativeTime } from "$shared/time";
  import { chat } from "$lib/chat.svelte";
  import { runTasks, taskState } from "$lib/panels";
  import PanelIcon, { type IconName } from "./PanelIcon.svelte";

  let { agents, now }: { agents: AgentsView; now: number } = $props();

  /** Recent runs whose tasks are open. */
  let open = $state<Record<string, boolean>>({});

  const STATE_ICON: Record<ReturnType<typeof taskState>, { icon: IconName; cls: string }> = {
    done: { icon: "check", cls: "text-success" },
    failed: { icon: "cross", cls: "text-error" },
    running: { icon: "spin", cls: "text-link" },
    waiting: { icon: "circle", cls: "text-muted" },
    unknown: { icon: "circle", cls: "text-muted" },
  };
  const WORD: Record<ReturnType<typeof taskState>, string> = {
    done: "done",
    failed: "failed",
    running: "running",
    waiting: "waiting",
    unknown: "",
  };

  const took = (r: AgentRun) =>
    r.startedAt !== undefined && r.completedAt !== undefined
      ? `took ${durationLabel(r.completedAt - r.startedAt)}`
      : undefined;
</script>

<div class="flex flex-col gap-3 p-3.5">
  <h2 class="section-label">Running now <span class="aside">· {agents.running.length}</span></h2>
  {#if agents.running.length === 0}
    <p class="px-0.5 text-small text-muted">No subagents running.</p>
  {/if}
  {#each agents.running as r (r.id)}
    <div class="panel-card flex flex-col gap-2.5 border-link/40! px-3.5 py-3">
      <div class="flex gap-2.5">
        <PanelIcon name="spin" class="mt-0.5 size-[18px] text-link" />
        <div class="flex min-w-0 flex-col gap-px">
          <span class="font-semibold wrap-break-word">{r.goal}</span>
          <span class="text-small text-muted">
            {runTasks(r)}{r.startedAt !== undefined ? ` · started ${relativeTime(r.startedAt, now).toLowerCase()}` : ""}
          </span>
        </div>
      </div>
      {@render tasks(r, true)}
    </div>
  {/each}

  <h2 class="section-label">Recent <span class="aside">· {agents.recent.length} in the last 7 days</span></h2>
  {#if agents.recent.length === 0}
    <p class="px-0.5 text-small text-muted">No subagents finished in the last 7 days.</p>
  {:else}
    <div class="panel-card">
      {#each agents.recent as r (r.id)}
        {@const expanded = open[r.id] === true}
        <div>
          <button
            type="button"
            class="panel-row-btn"
            aria-expanded={expanded}
            onclick={() => (open = { ...open, [r.id]: !expanded })}
          >
            <PanelIcon
              name={r.failed ? "cross" : "check"}
              class={["mt-0.5 size-4", r.failed ? "text-error" : "text-success"]}
            />
            <span class="flex min-w-0 flex-1 flex-col gap-px">
              <span class="wrap-break-word">{r.goal}</span>
              <span class="text-small text-muted">
                {[runTasks(r), took(r), relativeTime(r.startedAt, now)].filter(Boolean).join(" · ")}
              </span>
            </span>
            <PanelIcon name="chevron" class={["mt-0.5 size-3.5 text-muted transition-transform", expanded && "rotate-90"]} />
          </button>
          {#if expanded}
            <div class="px-3 pb-2.5 pl-9">{@render tasks(r, false)}</div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <p class="px-0.5 text-small text-muted">Subagents started from a chat here show as steps in that chat.</p>
</div>

{#snippet tasks(r: AgentRun, live: boolean)}
  <ul class={["flex flex-col gap-1.5", live && "pl-7"]}>
    {#each r.tasks as t, i (i)}
      {@const s = taskState(t.status, live)}
      <li class="flex items-start gap-2 text-small">
        <PanelIcon name={STATE_ICON[s].icon} class={["mt-0.5 size-3.5", STATE_ICON[s].cls]} />
        {#if t.key}
          <button type="button" class="link-btn min-w-0 flex-1 text-fg! wrap-break-word" title="Open its log" onclick={() => chat.openPanel(t.key)}>{t.goal}</button>
        {:else}
          <span class="min-w-0 flex-1 wrap-break-word">{t.goal}</span>
        {/if}
        {#if WORD[s]}
          <span class={["shrink-0", s === "running" ? "text-link" : "text-muted"]}>{WORD[s]}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}
