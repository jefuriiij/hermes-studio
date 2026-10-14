<script lang="ts">
  import { post } from "$lib/vscode";

  let {
    level,
    text,
    action,
  }: { level: "info" | "warning" | "error"; text: string; action?: "newChat" } = $props();

  // The host marks the notices whose fix is a fresh session (plan §5.6: after
  // a cancelled turn, after a refusal) — an explicit field, not a text match,
  // so rewording a notice can never silently drop its button.
  const offersNewChat = $derived(action === "newChat");

  const TONE = {
    info: { border: "border-info", icon: "text-info", glyph: "ℹ", label: "Info" },
    warning: { border: "border-warning", icon: "text-warning", glyph: "⚠", label: "Warning" },
    error: { border: "border-error", icon: "text-error", glyph: "✕", label: "Error" },
  } as const;
  const tone = $derived(TONE[level] ?? TONE.info);
</script>

<!-- No role="alert": the list is already a polite live region, and an `init`
     snapshot holding old errors would otherwise fire a burst of alerts. -->
<div class={["flex items-start gap-2 border-l-2 py-1 pr-1 pl-2 text-small", tone.border]}>
  <!-- Text presentation, so ⚠ and ℹ take the theme colour instead of turning
       into colour emoji. -->
  <span class={["shrink-0 [font-variant-emoji:text]", tone.icon]} aria-hidden="true">{tone.glyph}</span>
  <span class="sr-only">{tone.label}:</span>
  <p class="min-w-0 flex-1 wrap-break-word whitespace-pre-wrap">{text}</p>
  {#if offersNewChat}
    <button type="button" class="btn btn-secondary shrink-0" onclick={() => post({ type: "newChat" })}>
      New chat
    </button>
  {/if}
</div>
