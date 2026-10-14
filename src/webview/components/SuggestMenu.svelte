<script lang="ts">
  import { baseName, dirName, type Suggestion } from "$lib/suggest";

  let {
    id,
    sections,
    active,
    query,
    onpick,
    onhover,
    hint,
  }: {
    /** The listbox id; option i is `${id}-${i}` (the text box's aria-activedescendant). */
    id: string;
    sections: { title: string; items: Suggestion[] }[];
    active: number;
    query: string;
    onpick: (s: Suggestion) => void;
    onhover: (i: number) => void;
    hint: string;
  } = $props();

  let listEl: HTMLElement | undefined;
  $effect(() => {
    void active;
    listEl?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  });

  /** The typed part of a name, for the highlight: [before, match, after]. */
  function split(name: string): [string, string, string] {
    const q = query.toLowerCase();
    const i = q ? name.toLowerCase().indexOf(q) : -1;
    return i < 0 ? [name, "", ""] : [name.slice(0, i), name.slice(i, i + q.length), name.slice(i + q.length)];
  }

  // A flat index across the sections, for the highlight and the keys.
  const offsets = $derived(
    sections.reduce<number[]>((acc, s, i) => {
      acc.push(i === 0 ? 0 : (acc[i - 1] ?? 0) + (sections[i - 1]?.items.length ?? 0));
      return acc;
    }, []),
  );
</script>

<!-- Focus stays in the text box: the keys move the highlight (combobox list),
     a click picks. -->
<div
  {id}
  role="listbox"
  aria-label={sections[0]?.title ?? "Suggestions"}
  class="absolute right-0 bottom-full left-0 z-20 mb-1.5 flex max-h-[min(55vh,420px)] flex-col overflow-hidden rounded-[10px] border border-widget-border bg-widget p-1.5 shadow-lg shadow-shadow"
>
  <div class="min-h-0 flex-1 overflow-y-auto" bind:this={listEl}>
    {#each sections as section, si (section.title)}
      <div role="group" aria-label={section.title}>
        <div class="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{section.title}</div>
        {#each section.items as s, j (s.kind + s.name)}
          {@const i = (offsets[si] ?? 0) + j}
          {@const file = s.kind === "file" || s.kind === "folder"}
          {@const [a, b, c] = split(file ? baseName(s.name) : s.name)}
          <div
            id="{id}-{i}"
            role="option"
            tabindex="-1"
            aria-selected={i === active}
            class={[
              "flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-2 py-0.5",
              i === active ? "bg-selected text-selected-fg" : "",
            ]}
            onpointermove={() => onhover(i)}
            onpointerdown={(e) => e.preventDefault()}
            onclick={() => onpick(s)}
            onkeydown={() => undefined}
          >
            {#if file}
              <svg class="size-3.5 shrink-0 opacity-75" viewBox="0 0 16 16" aria-hidden="true">
                {#if s.kind === "folder"}
                  <path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                {:else}
                  <path d="M4 2h5l3 3v9H4zM9 2v3h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                {/if}
              </svg>
              <span class="shrink-0">{a}<mark class="bg-transparent font-bold text-link">{b}</mark>{c}</span>
              <span class={["min-w-0 flex-1 truncate text-small", i === active ? "opacity-80" : "text-muted"]}>
                {s.kind === "folder" ? "folder" : dirName(s.name)}
              </span>
            {:else}
              <span class="shrink-0 font-mono text-[12px]">/{a}<mark class="bg-transparent font-bold text-link">{b}</mark>{c}</span>
              {#if s.detail}
                <span class={["min-w-0 flex-1 truncate text-small", i === active ? "opacity-80" : "text-muted"]}>{s.detail}</span>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>
  <p class="shrink-0 border-t border-border px-2 pt-1 text-[11px] text-muted">{hint}</p>
</div>
