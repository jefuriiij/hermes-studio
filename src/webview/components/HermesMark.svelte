<script lang="ts">
  /** Box size in px; the glyph scales with it. */
  let { size = 18 }: { size?: number } = $props();
</script>

<!-- Decorative: the "Hermes" text beside it (or the heading) names it. -->
<span
  class="hermes-mark"
  style:width="{size}px"
  style:height="{size}px"
  style:border-radius="{Math.round(size * 0.28)}px"
  aria-hidden="true"
>
  <svg width={Math.round(size * 0.62)} height={Math.round(size * 0.62)} viewBox="0 0 24 24">
    <path fill="currentColor" d="M4 4h3.2v6.6h7.6V4H18v16h-3.2v-6.6H7.2V20H4z" />
    <path
      fill="currentColor"
      d="M18 4.2c1.9-1.5 3.6-1.6 5-.9-1.1.4-2 1.1-2.6 2.1.8-.1 1.6 0 2.3.4-1.3.4-2.6 1.3-3.4 2.6H18z"
    />
  </svg>
</span>
