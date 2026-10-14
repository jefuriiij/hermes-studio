<script lang="ts">
  import type { DiffView } from "$shared/chat";

  /** `onopen`: show the full diff in VS Code's diff editor. */
  let { diff, onopen }: { diff: DiffView; onopen?: () => void } = $props();

  const SIGN = { add: "+", del: "−", ctx: " ", gap: "" } as const;
</script>

<!-- Text arrives already sanitized (invisible characters as escapes) and
     capped by the host; Svelte escapes it again as plain text. -->
<div class="diff-block" role="group" aria-label="Proposed change to {diff.path}">
  <div class="max-h-80 overflow-auto">
    <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
      <tbody>
        {#each diff.lines as line, i (i)}
          {#if line.kind === "gap"}
            <tr class="diff-gap">
              <td class="diff-no"></td>
              <td colspan="2" class="px-2 italic">⋯ {line.text}</td>
            </tr>
          {:else}
            <tr class={`diff-${line.kind}`}>
              <td class="diff-no">{line.kind === "del" ? line.oldNo ?? "" : line.newNo ?? ""}</td>
              <td class="diff-sign" aria-hidden="true">{SIGN[line.kind]}</td>
              <td class="pr-3 whitespace-pre">
                <span class="sr-only">{line.kind === "add" ? "added: " : line.kind === "del" ? "removed: " : ""}</span>{line.text}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
  {#if diff.truncated}
    <div class="border-t border-border px-2.5 py-1 text-small text-muted">
      Longer than this card shows.
      {#if onopen}
        <button type="button" class="cursor-pointer text-link hover:underline" onclick={onopen}>Open the full diff</button>
      {/if}
    </div>
  {/if}
</div>
