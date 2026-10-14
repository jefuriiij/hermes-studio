<script lang="ts">
  import { EFFORT_LEVELS, type EffortLevel, effortDots, effortLabel } from "$shared/effort";
  import { effortTone, magnet, positionOf, stopAt } from "$lib/levels";

  let {
    value,
    loading,
    saving,
    error,
    onpick,
    el = $bindable(),
  }: {
    /** What config.yaml says (null: not set — Hermes uses medium). */
    value: string | null;
    loading: boolean;
    saving: boolean;
    error?: string;
    onpick: (level: EffortLevel) => void;
    /** The focusable slider, for the pop-up's arrow-key list. */
    el?: HTMLElement;
  } = $props();

  /** The step Hermes has (1–5); a value off the scale shows at its nearest end. */
  const current = $derived(Math.max(1, effortDots(value)));
  /** 0–1 along the track while the thumb is dragged. */
  let drag = $state<number | null>(null);
  const step = $derived(drag === null ? current : stopAt(drag));
  const pos = $derived(drag === null ? positionOf(current) : magnet(drag));
  const tone = $derived(effortTone(step));
  const label = $derived(
    drag === null ? effortLabel(value) : (EFFORT_LEVELS[step - 1]?.label ?? ""),
  );
  const busy = $derived(loading || saving);

  // "Saved ✓" for a moment after a save that worked.
  let saved = $state(false);
  let wasSaving = false;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const now = saving;
    if (wasSaving && !now && !error) {
      saved = true;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (saved = false), 1600);
    }
    wasSaving = now;
    return () => clearTimeout(savedTimer);
  });

  let track: HTMLElement | undefined = $state();
  function at(e: PointerEvent): number {
    const r = track?.getBoundingClientRect();
    return r && r.width > 0 ? (e.clientX - r.left) / r.width : 0;
  }

  function commit(next: number): void {
    const level = EFFORT_LEVELS[next - 1];
    if (level && next !== current) onpick(level.id);
  }

  function onpointerdown(e: PointerEvent): void {
    if (busy || e.button !== 0) return;
    e.preventDefault();
    el?.focus();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = at(e);
  }
  function onpointermove(e: PointerEvent): void {
    if (drag !== null) drag = at(e);
  }
  function onpointerup(): void {
    if (drag === null) return;
    const next = stopAt(drag);
    drag = null; // the thumb springs onto the stop
    commit(next);
  }

  // ←/→ step, Home/End jump; Up/Down stay with the pop-up's list.
  function onkeydown(e: KeyboardEvent): void {
    let next = 0;
    if (e.key === "ArrowRight") next = current + 1;
    else if (e.key === "ArrowLeft") next = current - 1;
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = EFFORT_LEVELS.length;
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (!busy) commit(Math.min(EFFORT_LEVELS.length, Math.max(1, next)));
  }
</script>

<div class="flex flex-col gap-0.5" style:--tone={tone}>
  <div class="flex items-center gap-2 px-2 pt-1.5">
    <span class="text-small font-semibold">Effort</span>
    <span class="effort-label min-w-0 flex-1 truncate text-small font-semibold" aria-hidden="true">
      {loading ? "…" : label}
    </span>
    {#if saving}
      <span class="text-small text-muted" aria-live="polite">Saving…</span>
    {:else if saved}
      <span class="effort-saved flex items-center gap-1 text-small" aria-live="polite">
        <svg class="size-3" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Saved
      </span>
    {/if}
  </div>

  <div
    bind:this={el}
    role="slider"
    tabindex="0"
    aria-label="Effort"
    aria-valuemin={1}
    aria-valuemax={EFFORT_LEVELS.length}
    aria-valuenow={step}
    aria-valuetext={label}
    aria-disabled={busy}
    class={["effort-slider", busy && "is-busy"]}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    onpointercancel={() => (drag = null)}
    onlostpointercapture={onpointerup}
    {onkeydown}
  >
    <div class="effort-track" bind:this={track}>
      <div class={["effort-fill", drag === null && "is-snapping", saving && "is-saving"]} style:width="{pos * 100}%"></div>
      {#each EFFORT_LEVELS as l, i (l.id)}
        <span class={["effort-stop", i < step && "is-on"]} style:left="{(i / (EFFORT_LEVELS.length - 1)) * 100}%"></span>
      {/each}
      <span class={["effort-thumb", drag === null && "is-snapping"]} style:left="{pos * 100}%">
        {#if saving}<span class="effort-ring"></span>{/if}
      </span>
    </div>
    <div class="effort-names" aria-hidden="true">
      {#each EFFORT_LEVELS as l, i (l.id)}
        <span style:left="{(i / (EFFORT_LEVELS.length - 1)) * 100}%" class={[i + 1 === step && "is-here"]}>
          {l.id === "xhigh" ? "Extra" : l.label}
        </span>
      {/each}
    </div>
  </div>
</div>
