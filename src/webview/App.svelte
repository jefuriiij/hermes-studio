<script lang="ts">
  import { chat } from "$lib/chat.svelte";
  import { panelId, tabId } from "$lib/panels";
  import { waitingForApproval } from "$lib/rows";
  import ActivityLine from "./components/ActivityLine.svelte";
  import ChatElsewhere from "./components/ChatElsewhere.svelte";
  import Composer from "./components/Composer.svelte";
  import Header from "./components/Header.svelte";
  import ImagePreview from "./components/ImagePreview.svelte";
  import LimitBanner from "./components/LimitBanner.svelte";
  import MessageList from "./components/MessageList.svelte";
  import PanelTabs from "./components/panels/PanelTabs.svelte";
  import PanelView from "./components/panels/PanelView.svelte";
  import QueuedMessages from "./components/QueuedMessages.svelte";
  import SessionsPopover from "./components/SessionsPopover.svelte";

  // Deriveds cut propagation by identity: a meta-only op (usage, busy) keeps
  // the same items array, so the list and its scroll effect stay untouched.
  const items = $derived(chat.model.items);
  const meta = $derived(chat.model.meta);
  const waiting = $derived(waitingForApproval(items));
  const tab = $derived(chat.tab);
</script>

<!-- The tabs sit above everything. The chat stays laid out under the other
     tabs (invisible and inert): its scroll position, open steps and a
     streaming reply carry on while a panel is on screen. The Sessions pop-up
     drops down OVER the chat, which keeps its draft and its reply. An image
     preview covers the chat, which is `inert` meanwhile so Tab cannot wander
     into it. -->
<div class="flex h-full flex-col">
  <PanelTabs busy={meta.busy} {waiting} />
  <div class="relative min-h-0 flex-1">
    <div
      role="tabpanel"
      id={panelId("chat")}
      aria-labelledby={tabId("chat")}
      class={["flex h-full flex-col", tab !== "chat" && "invisible"]}
      inert={tab !== "chat" || chat.preview !== null}
    >
      {#if chat.here}
        <Header {meta} {waiting} />
        <MessageList {items} {meta} />
        <ActivityLine {items} {meta} />
        <LimitBanner {meta} />
        <QueuedMessages {meta} />
        <Composer {meta} />
      {:else}
        <ChatElsewhere />
      {/if}
    </div>
    {#if tab !== "chat"}
      <PanelView {tab} />
    {/if}
    {#if chat.here && chat.sessionsOpen}
      <SessionsPopover {meta} />
    {/if}
    {#if chat.here}
      <ImagePreview />
    {/if}
  </div>
</div>
