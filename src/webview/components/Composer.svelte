<script lang="ts">
  import type { ChatMeta } from "$shared/chat";
  import { IMAGE_TYPES, MAX_IMAGE_CHARS, MAX_PROMPT_CHARS } from "$shared/protocol";
  import { chat } from "$lib/chat.svelte";
  import {
    canSend,
    composerPlaceholder,
    modeIcon,
    modeLabel,
    usagePercent,
    usageTooltip,
  } from "$lib/format";
  import { uriList } from "$lib/drop";
  import { lowUsage, slugOf, usageView } from "$lib/usage";
  import { modeTone } from "$lib/levels";
  import {
    mentionAt,
    mentionSegments,
    type Suggestion,
    slashAt,
    slashSuggestions,
    skillsIn,
  } from "$lib/suggest";
  import { post } from "$lib/vscode";
  import { tick } from "svelte";
  import AddMenu from "./AddMenu.svelte";
  import ContextIcon from "./ContextIcon.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import EditorChip from "./EditorChip.svelte";
  import ImageThumb from "./ImageThumb.svelte";
  import ModeGlyph from "./ModeGlyph.svelte";
  import ModeMenu from "./ModeMenu.svelte";
  import ModelMenu from "./ModelMenu.svelte";
  import SuggestMenu from "./SuggestMenu.svelte";

  let { meta }: { meta: ChatMeta } = $props();

  let modelChip: HTMLButtonElement | undefined = $state();
  let modeChip: HTMLButtonElement | undefined = $state();
  let plusBtn: HTMLButtonElement | undefined = $state();
  let ringBtn: HTMLButtonElement | undefined = $state();

  const context = $derived(chat.context);
  /** A short message under the chips (an image that cannot be added). */
  let note = $state("");
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  function showNote(text: string): void {
    note = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (note = ""), 6000);
  }

  /** A pasted image becomes a chip. Text on the clipboard wins: a spreadsheet
   *  or a document copies an image of itself next to its text. */
  function onpaste(e: ClipboardEvent): void {
    const data = e.clipboardData;
    if (!data || !context.images || data.getData("text/plain")) return;
    const files = [...data.files].filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    addImageFiles(files);
  }

  /** Pasted or dropped pictures become image chips (base64 to the host). */
  function addImageFiles(files: readonly File[]): void {
    for (const f of files) {
      if (!IMAGE_TYPES.has(f.type)) {
        showNote("Only PNG, JPEG, GIF and WebP images can be added.");
        continue;
      }
      if (Math.ceil(f.size / 3) * 4 > MAX_IMAGE_CHARS) {
        showNote("That image is too large (about 3.7 MB at most).");
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        const data = url.slice(url.indexOf(",") + 1);
        if (data) post({ type: "pasteImage", mimeType: f.type, data });
      };
      reader.readAsDataURL(f);
    }
  }

  // ── Drag and drop (VS Code hands a webview a drop only with Shift held) ──
  let dragDepth = $state(0);
  const DROP_TYPES = ["application/vnd.code.uri-list", "text/uri-list", "Files"];
  const droppable = (e: DragEvent) =>
    [...(e.dataTransfer?.types ?? [])].some((t) => DROP_TYPES.includes(t));

  function ondragenter(e: DragEvent): void {
    if (!droppable(e)) return;
    e.preventDefault();
    dragDepth++;
  }

  function ondragover(e: DragEvent): void {
    if (!droppable(e) || !e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function ondragleave(): void {
    dragDepth = Math.max(0, dragDepth - 1);
  }

  function ondrop(e: DragEvent): void {
    const dt = e.dataTransfer;
    dragDepth = 0;
    if (!dt) return;
    e.preventDefault();
    // VS Code's Explorer and editor tabs give URIs; the host checks each one.
    const uris = uriList(dt.getData("application/vnd.code.uri-list") || dt.getData("text/uri-list"));
    if (uris.length > 0) {
      post({ type: "dropUris", uris: uris.slice(0, 50) });
      return;
    }
    // From outside VS Code only the bytes arrive: pictures can be read that way.
    const files = [...dt.files];
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length > 0 && context.images) addImageFiles(images);
    if (images.length < files.length) {
      showNote("Files from outside VS Code cannot be added: drop them from VS Code's Explorer.");
    }
  }

  // In the store: the limit banner opens the model menu too.
  const menu = $derived(chat.menu);
  const busy = $derived(meta.busy);
  const switchable = $derived(!busy && !meta.switchingModel && (meta.models?.length ?? 0) > 0);
  const currentMode = $derived(meta.modes?.find((m) => m.id === meta.mode));
  const modelTitle = $derived.by(() => {
    const name = `Model: ${meta.model ?? "unknown"}`;
    if (meta.switchingModel) return `Switching to ${meta.switchingModel}…`;
    if (busy) return `${name} — switch when Hermes is idle`;
    return switchable ? `${name} — switch (keeps this conversation)` : name;
  });
  // The current model's subscription running low: said on the model chip
  // ("17% left"), every limit in its tooltip.
  const planUsage = $derived(usageView(chat.accountUsage.byProvider[slugOf(meta.modelId)], Date.now()));
  const low = $derived(lowUsage(planUsage, meta.limit?.kind === "limit"));
  const modelChipTitle = $derived(low && planUsage ? `${modelTitle}\n\n${planUsage.tooltip}` : modelTitle);

  // Hermes refuses a switch mid-turn: a turn starting closes the model menu.
  $effect(() => {
    if (busy && menu === "model") chat.menu = null;
  });

  function toggle(which: "model" | "mode" | "add" | "context"): void {
    chat.menu = menu === which ? null : which;
  }

  function closeMenu(why: "pick" | "escape" | "outside"): void {
    const which = menu;
    chat.menu = null;
    const trigger = { model: modelChip, mode: modeChip, add: plusBtn, context: ringBtn };
    if (why === "escape" && which) trigger[which]?.focus();
    else if (why === "pick") chat.focusComposer();
  }

  const tooLong = $derived(chat.draft.length > MAX_PROMPT_CHARS);
  const sendable = $derived(canSend(meta) && chat.draft.trim().length > 0 && !tooLong);

  const usage = $derived(meta.usage ? usagePercent(meta.usage) : undefined);
  /** Circumference of the context ring (r = 7.5). */
  const RING = 2 * Math.PI * 7.5;
  const ringTone = $derived(
    usage === undefined ? "" : usage.ratio >= 0.9 ? "text-error" : usage.ratio >= 0.7 ? "text-warning" : "text-muted",
  );

  /** Drop leading blank lines and trailing whitespace, but keep the first
   *  line's indentation (a pasted code snippet). */
  function normalize(text: string): string {
    return text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
  }

  // ── The "/" and "@" lists ────────────────────────────────────────────────
  let ta: HTMLTextAreaElement | undefined = $state();
  let mirror: HTMLDivElement | undefined = $state();
  const skills = $derived(chat.panels?.capabilities.skills ?? []);
  const commands = $derived(meta.commands ?? []);
  const segments = $derived(mentionSegments(chat.draft, skills));
  const mentioned = $derived(segments.some((s) => s.mention));
  // The copy follows the textarea's scroll (it appears mid-scroll too).
  $effect(() => {
    if (mirror && ta) mirror.scrollTop = ta.scrollTop;
  });
  const suggestId = $props.id();
  let trigger = $state<
    | { kind: "slash"; query: string; start: number; atStart: boolean }
    | { kind: "mention"; query: string; start: number }
    | null
  >(null);
  let suggestActive = $state(0);
  /** Esc closed the list: it stays closed until the text changes. */
  let closedFor: string | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  /** Where the caret is decides the list: "/…" at the start, "@…" anywhere. */
  function updateTrigger(): void {
    const el = ta;
    if (!el || el.selectionStart !== el.selectionEnd || chat.draft === closedFor) {
      trigger = null;
      return;
    }
    closedFor = null;
    const caret = el.selectionStart ?? 0;
    const slash = slashAt(chat.draft, caret);
    const mention = slash ? undefined : mentionAt(chat.draft, caret);
    const next = slash
      ? ({ kind: "slash", query: slash.query, start: slash.start, atStart: slash.atStart } as const)
      : mention
        ? ({ kind: "mention", query: mention.query, start: mention.start } as const)
        : null;
    if (next?.query !== trigger?.query || next?.kind !== trigger?.kind) suggestActive = 0;
    if (next?.kind === "mention" && (trigger?.kind !== "mention" || trigger.query !== next.query)) {
      clearTimeout(searchTimer);
      const q = next.query;
      searchTimer = setTimeout(() => chat.searchFiles(q), 60);
    }
    trigger = next;
  }

  const sections = $derived.by(() => {
    if (!trigger) return [];
    if (trigger.kind === "slash") {
      // Mid-text only skills: Hermes runs a command only as the whole message.
      const r = slashSuggestions(skills, trigger.atStart ? commands : [], trigger.query);
      const out: { title: string; items: Suggestion[] }[] = [];
      if (r.skills.length) {
        const of =
          r.skillMatches < skills.length ? ` · ${r.skillMatches} of ${skills.length}` : ` · ${skills.length}`;
        out.push({ title: `Skills${of}`, items: r.skills });
      }
      if (r.commands.length) out.push({ title: "Hermes commands", items: r.commands });
      return out;
    }
    const items = chat.fileResults.items.map((h): Suggestion => ({ kind: h.kind, name: h.path }));
    return items.length ? [{ title: "Files", items }] : [];
  });
  const flat = $derived(sections.flatMap((x) => x.items));
  const suggesting = $derived(!!trigger && flat.length > 0 && menu === null);

  async function pick(s: Suggestion | undefined): Promise<void> {
    const el = ta;
    const t = trigger;
    if (!s || !el || !t) return;
    const caret = el.selectionStart ?? 0;
    const text = chat.draft;
    let at = 0;
    if (s.kind === "skill" && t.kind === "slash") {
      // The skill stays where it was typed, as "/name" (gold, as "@file" is).
      const insert = `/${s.name} `;
      chat.draft = text.slice(0, t.start) + insert + text.slice(caret).replace(/^\s+/, "");
      at = t.start + insert.length;
    } else if (s.kind === "command") {
      const insert = `/${s.name} `;
      chat.draft = insert + text.slice(caret).replace(/^\s+/, "");
      at = insert.length;
    } else if (t.kind === "mention") {
      const insert = `@${s.name}${s.kind === "folder" ? "/" : ""} `;
      chat.draft = text.slice(0, t.start) + insert + text.slice(caret);
      at = t.start + insert.length;
      if (s.kind === "file") chat.mentionFile(s.name);
    }
    trigger = null;
    await tick();
    el.focus();
    el.setSelectionRange(at, at);
  }

  function send(): void {
    // While Hermes works the host queues it (mock board 17): one turn at a
    // time still, the next one waits for the reply to end.
    if (!sendable) return;
    const text = normalize(chat.draft);
    if (!text) return;
    // Every "/skill" in the text counts, wherever it was typed. A chip (a
    // queued message put back) counts too.
    const named = skillsIn(text, skills, commands);
    const picked = chat.skill && !named.includes(chat.skill) ? [chat.skill, ...named] : named;
    post({ type: "send", text, ...(picked.length ? { skills: picked } : {}) });
    chat.draft = "";
    chat.skill = null;
    trigger = null;
  }

  function stop(): void {
    post({ type: "cancel" });
  }

  function onkeydown(e: KeyboardEvent): void {
    if (suggesting && !e.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = flat.length;
        suggestActive = (suggestActive + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        void pick(flat[suggestActive]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // close the list; never Stop Hermes from here
        closedFor = chat.draft;
        trigger = null;
        return;
      }
    }
    if (e.key === "Backspace" && chat.skill && chat.draft === "" && ta?.selectionStart === 0) {
      // Backspace in an empty box takes the skill chip off.
      e.preventDefault();
      chat.skill = null;
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // An IME uses Enter to commit its composition; that Enter is not a send.
      // keyCode 229 covers engines that end composition before keydown.
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      send();
    } else if (e.key === "Escape" && meta.busy) {
      e.preventDefault();
      stop();
    }
  }

  function onsubmit(e: SubmitEvent): void {
    e.preventDefault();
    send();
  }
</script>

<!-- @container: where the current-file chip goes depends on the composer's
     width (the bottom row when there is room, like Claude; else the chips row). -->
<form class="@container mx-auto w-full max-w-4xl shrink-0 px-3 pb-3" {onsubmit} {ondragenter} {ondragover} {ondragleave} {ondrop}>
  <!-- The outline (and the mode chip) take the edit mode's colour (mock board 21). -->
  <div
    class={[
      "composer-box relative flex flex-col rounded-[10px] border border-input-border bg-input text-input-fg focus-within:outline-1 focus-within:-outline-offset-1",
      dragDepth > 0 && "outline-2 -outline-offset-2 outline-focus",
    ]}
    style:--mode-tone={modeTone(meta.mode)}
  >
    {#if dragDepth > 0}
      <!-- Over the whole box while something is dragged over it. -->
      <div
        class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[10px] bg-input/90 text-small font-semibold text-fg"
      >
        Drop to add to the message
      </div>
    {/if}
    {#if menu === "model"}
      <ModelMenu {meta} onclose={closeMenu} />
    {:else if menu === "mode"}
      <ModeMenu {meta} onclose={closeMenu} />
    {:else if menu === "add"}
      <AddMenu onclose={closeMenu} />
    {:else if menu === "context"}
      <ContextMenu {meta} onclose={closeMenu} />
    {/if}
    {#if suggesting}
      <SuggestMenu
        id={suggestId}
        {sections}
        active={suggestActive}
        query={trigger?.query ?? ""}
        onpick={(s) => void pick(s)}
        onhover={(i) => (suggestActive = i)}
        hint={trigger?.kind === "mention"
          ? "↑↓ to move · Enter or Tab to add · Esc to close"
          : "↑↓ to move · Enter or Tab to pick · Esc to close"}
      />
    {/if}
    {#if context.items.length > 0 || note || chat.editor || chat.skill}
      <div
        class={[
          "flex flex-wrap gap-1.5 px-2 pt-2",
          // Holding only the current file, the row is not needed when wide.
          context.items.length === 0 && !note && !chat.skill && "@min-[520px]:hidden",
        ]}
        aria-label="Added to the message"
        role="group"
      >
        {#if chat.skill}
          <span class="ctx-chip ctx-chip-skill" title="Hermes loads the {chat.skill} skill for this message">
            <ContextIcon kind="skill" class="size-3" />
            <span class="truncate">skill · {chat.skill}</span>
            <button
              type="button"
              class="ctx-chip-x"
              aria-label="Remove the {chat.skill} skill"
              title="Remove"
              onclick={() => {
                chat.skill = null;
                ta?.focus();
              }}
            >
              <svg class="size-2.5" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </svg>
            </button>
          </span>
        {/if}
        <div class="flex max-w-full min-w-0 @min-[520px]:hidden"><EditorChip /></div>
        {#each context.items as c (c.id)}
          <span class={["ctx-chip", c.kind === "image" && "pl-[3px]"]} title={c.detail ?? c.label}>
            {#if c.kind === "image"}
              <button type="button" class="ctx-chip-open" aria-label="View {c.label}" onclick={() => chat.openImage(c)}>
                <ImageThumb id={c.id} />
                <span class="truncate">{c.label}</span>
                {#if c.size}<span class="shrink-0 text-muted tabular-nums">{c.size}</span>{/if}
              </button>
            {:else}
              <ContextIcon kind={c.kind} class="size-3 opacity-75" />
              <span class="truncate">{c.label}</span>
            {/if}
            <button
              type="button"
              class="ctx-chip-x"
              aria-label="Remove {c.label}"
              title="Remove"
              onclick={() => chat.removeContext(c.id)}
            >
              <svg class="size-2.5" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </svg>
            </button>
          </span>
        {/each}
        {#if note}
          <span class="self-center text-small text-warning" aria-live="polite">{note}</span>
        {/if}
      </div>
    {/if}
    <!-- field-sizing: content grows the textarea with its text (Chromium 123+;
         the webview floor is 138), capped at 40% of the view.
         "@path" shows in Hermes gold (mock board 19B): a textarea colours all
         its text alike, so while the text has a mention the textarea's own
         text is transparent and a copy behind it, laid out the same way
         (padding, wrapping, scroll gutter), draws the words. -->
    <div class="relative">
    {#if mentioned}
      <div
        bind:this={mirror}
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 overflow-hidden px-3 pt-2.5 pb-1 wrap-break-word whitespace-pre-wrap text-input-fg scrollbar-gutter-stable"
      >{#each segments as s, i (i)}{#if s.mention}<span class="at-mention">{s.text}</span>{:else}{s.text}{/if}{/each}{" "}</div>
    {/if}
    <textarea
      onscroll={() => {
        if (mirror && ta) mirror.scrollTop = ta.scrollTop;
      }}
      bind:this={ta}
      {@attach (el) => chat.registerComposer(el)}
      bind:value={chat.draft}
      {onkeydown}
      {onpaste}
      oninput={updateTrigger}
      onkeyup={(e) => {
        // The caret moved (arrows, Home/End): the list follows it.
        if (!suggesting || !["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) updateTrigger();
      }}
      onclick={updateTrigger}
      onblur={() => (trigger = null)}
      role="combobox"
      aria-expanded={suggesting}
      aria-controls={suggestId}
      aria-activedescendant={suggesting ? `${suggestId}-${suggestActive}` : undefined}
      aria-autocomplete="list"
      rows="1"
      aria-label="Message Hermes"
      placeholder={composerPlaceholder(meta)}
      class={[
        "relative block max-h-[40vh] min-h-[calc(2lh+14px)] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 field-sizing-content outline-none scrollbar-gutter-stable placeholder:text-placeholder",
        mentioned && "text-transparent caret-input-fg",
      ]}
    ></textarea>
    </div>
    <div class="flex min-w-0 items-center gap-2 px-2 pb-2">
      <button
        bind:this={plusBtn}
        type="button"
        class="plus-btn"
        data-menu-trigger
        aria-haspopup="menu"
        aria-expanded={menu === "add"}
        aria-label="Add files, an image or context"
        title="Add files, an image or context"
        onclick={() => toggle("add")}
      >
        <svg class="size-3.5" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      {#if tooLong}
        <span class="mr-auto text-small text-error" aria-live="polite">
          Too long: {chat.draft.length.toLocaleString("en-US")} / {MAX_PROMPT_CHARS.toLocaleString("en-US")} characters
        </span>
      {:else}
        {#if usage && meta.usage}
          <button
            bind:this={ringBtn}
            type="button"
            class={["ring-btn", ringTone]}
            data-menu-trigger
            aria-haspopup="dialog"
            aria-expanded={menu === "context"}
            aria-label="Context: {usage.label} used. Show details"
            title={usageTooltip(meta.usage)}
            onclick={() => toggle("context")}
          >
            <svg class="size-4" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2.4" />
              <circle
                cx="10"
                cy="10"
                r="7.5"
                fill="none"
                stroke="currentColor"
                stroke-width="2.4"
                stroke-linecap="round"
                stroke-dasharray="{Math.max(usage.ratio * RING, 0.6)} {RING}"
                transform="rotate(-90 10 10)"
              />
            </svg>
            {usage.label}
          </button>
        {/if}
        {#if meta.model || meta.switchingModel}
          <button
            bind:this={modelChip}
            type="button"
            class={["chip min-w-16", low && (low.tone === "error" ? "chip-error" : "chip-warning")]}
            data-menu-trigger
            aria-haspopup="listbox"
            aria-expanded={menu === "model"}
            aria-label={low ? `${modelTitle}. Subscription: ${low.text}` : modelTitle}
            title={modelChipTitle}
            disabled={!switchable}
            onclick={() => toggle("model")}
          >
            {#if meta.switchingModel}
              <span
                class="size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-link border-t-transparent"
                aria-hidden="true"
              ></span>
              <span class="truncate">Switching…</span>
            {:else}
              <span class="truncate">{meta.model}</span>
              {#if low}
                <span class={["shrink-0", low.tone === "error" ? "text-error" : "text-warning"]}>
                  · <span class="hidden @min-[500px]:inline">{low.text}</span><span class="@min-[500px]:hidden"
                    >{low.short}</span
                  >
                </span>
              {/if}
              <svg class="size-2.5 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {/if}
          </button>
        {/if}
        <div class="hidden max-w-[40%] min-w-11 shrink-[4] @min-[520px]:flex"><EditorChip /></div>
        <span class="flex-1"></span>
        {#if meta.modes && meta.modes.length > 0}
          <button
            bind:this={modeChip}
            type="button"
            class="chip mode-chip shrink-0"
            data-menu-trigger
            aria-haspopup="menu"
            aria-expanded={menu === "mode"}
            aria-label="Mode and effort: {modeLabel(currentMode)}"
            title="Mode and effort: {modeLabel(currentMode)}"
            onclick={() => toggle("mode")}
          >
            <ModeGlyph icon={modeIcon(currentMode)} class="size-3" />
            <span class="truncate">{modeLabel(currentMode)}</span>
            <svg class="size-2.5 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        {/if}
      {/if}
      {#if meta.busy}
        <button
          type="submit"
          class="icon-btn icon-btn-secondary"
          disabled={!sendable}
          aria-label="Queue: sends when Hermes is done"
          title="Queue (Enter) — sends when Hermes is done"
        >
          <svg class="size-4" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 13V3M4 7l4-4 4 4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button type="button" class="icon-btn icon-btn-stop" onclick={stop} aria-label="Stop" title="Stop (Esc)">
          <svg class="size-3" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
          </svg>
        </button>
      {:else}
        <button type="submit" class="icon-btn icon-btn-primary" disabled={!sendable} aria-label="Send" title="Send (Enter)">
          <svg class="size-4" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 13V3M4 7l4-4 4 4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      {/if}
    </div>
  </div>
</form>
