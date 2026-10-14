<script lang="ts">
  import type { CuratorCard, LearningRow, LearningView } from "$shared/panels";
  import { dayLabel, relativeTime } from "$shared/time";
  import { chat } from "$lib/chat.svelte";
  import { plural, weekHeadline } from "$lib/panels";
  import PanelIcon from "./PanelIcon.svelte";

  let { learning, curator, now }: { learning: LearningView; curator: CuratorCard; now: number } =
    $props();

  /** Rows before "Show more" (the host sends up to 15). */
  const FIRST = 6;
  let all = $state(false);
  const rows = $derived(all ? learning.items : learning.items.slice(0, FIRST));

  const KIND: Record<LearningRow["kind"], string> = {
    new: "New skill",
    learned: "Learned",
    improved: "Improved",
  };

  const curatorState = $derived(
    curator.state === "off" ? "Off" : curator.state === "paused" ? "Paused" : `On · ${curator.every}`,
  );
  const nextRun = $derived(
    curator.nextRunAt === undefined
      ? undefined
      : curator.nextRunAt <= now
        ? `due, when Hermes has been idle ${curator.minIdleHours} h`
        : `from ${dayLabel(curator.nextRunAt, now)}, when idle ${curator.minIdleHours} h`,
  );
</script>

<div class="flex flex-col gap-3 p-3.5">
  <!-- This week -->
  <div
    class="flex items-center gap-3.5 rounded-lg border border-hermes/35 bg-hermes/8 px-3.5 py-3"
  >
    <PanelIcon name="sparkle" class="size-7 text-hermes" />
    <div class="flex min-w-0 flex-col gap-0.5">
      <span class="font-semibold">{weekHeadline(learning)}</span>
      <span class="text-small text-muted">
        {plural(learning.learnedTotal, "skill")} learned in total · {plural(learning.skillsTotal, "skill")} available
      </span>
    </div>
  </div>

  <h2 class="section-label">Recent changes</h2>
  {#if learning.items.length === 0}
    <p class="px-0.5 text-small text-muted">Hermes has not learned or changed a skill in the last 30 days.</p>
  {:else}
    <div class="panel-card">
      {#each rows as r (r.skill)}
        <div class="flex gap-2.5 px-3 py-2.5">
          {#if r.kind === "improved"}
            <PanelIcon name="pencil" class="mt-0.5 size-4 text-muted" />
          {:else}
            <PanelIcon name="sparkle" class="mt-0.5 size-[18px] text-hermes" />
          {/if}
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <span class="font-semibold">{KIND[r.kind]}</span>
              {#if r.open}
                <button type="button" class="link-btn min-w-0 font-mono text-fg! break-all" title="Open its SKILL.md" onclick={() => chat.openPanel(r.open)}>{r.skill}</button>
              {:else}
                <span class="min-w-0 font-mono break-all">{r.skill}</span>
              {/if}
              {#if r.diff?.added !== undefined}
                <span class="text-small tabular-nums" title="Lines in the latest change">
                  <span class="text-success">+{r.diff.added}</span>
                  <span class="text-error">−{r.diff.removed}</span>
                </span>
              {/if}
            </span>
            {#if r.kind !== "improved" && r.description}
              <span class="line-clamp-2 text-small text-muted">{r.description}</span>
            {/if}
            <span class="text-small">
              {#if r.changes > 1}
                <button type="button" class="link-btn" onclick={() => chat.openPanel(r.history)}>{plural(r.changes, "change")}</button>
                <span class="text-muted">·</span>
              {/if}
              <span class="text-muted">{relativeTime(r.lastChangeAt, now)}</span>
              {#if r.session}
                <span class="text-muted">· from</span>
                <button type="button" class="link-btn" onclick={() => chat.openPanel(r.session?.key)}>{r.session.title}</button>
              {/if}
              {#if r.diff && r.kind === "improved"}
                <span class="text-muted">·</span>
                <button type="button" class="link-btn" onclick={() => chat.openPanel(r.diff?.key)}>see the diff</button>
              {/if}
            </span>
          </div>
        </div>
      {/each}
      {#if learning.items.length > FIRST || learning.allChanges}
        <div class="flex flex-wrap gap-x-3 px-3 py-2 text-small">
          {#if learning.items.length > FIRST}
            <button type="button" class="link-btn" onclick={() => (all = !all)}>
              {all ? "Show fewer" : `Show ${learning.items.length - FIRST} more`}
            </button>
          {/if}
          {#if learning.allChanges}
            <button type="button" class="link-btn" onclick={() => chat.openPanel(learning.allChanges)}>
              All {learning.totalChanges} changes{learning.firstChangeAt ? ` since ${relativeTime(learning.firstChangeAt, now)}` : ""}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <h2 class="section-label">Curator</h2>
  <div class="panel-card flex flex-col gap-2 px-3.5 py-3">
    <div class="flex flex-wrap items-center gap-x-2">
      <span
        class={[
          "size-2 shrink-0 rounded-full border border-hc",
          curator.state === "on" ? "bg-success" : curator.state === "paused" ? "bg-warning" : "bg-muted",
        ]}
        aria-hidden="true"
      ></span>
      <span class="font-semibold">{curatorState}</span>
      <span class="text-small text-muted">· tidies the skills Hermes learned</span>
    </div>
    <div class="grid grid-cols-2 gap-2 text-small">
      <div>
        <div class="text-muted">Last run</div>
        <div>
          {curator.lastRunAt === undefined ? "Not run yet" : relativeTime(curator.lastRunAt, now)}{curator.summary ? ` · ${curator.summary}` : ""}
        </div>
      </div>
      {#if nextRun}
        <div>
          <div class="text-muted">Next run</div>
          <div>{nextRun}</div>
        </div>
      {/if}
    </div>
    <div class="text-small">
      {#if curator.report}
        <button type="button" class="link-btn" onclick={() => chat.openPanel(curator.report)}>Open the last report</button>
        <span class="text-muted">·</span>
      {/if}
      <span class="text-muted">merging similar skills is {curator.consolidate ? "on" : "off"}</span>
    </div>
  </div>
</div>
