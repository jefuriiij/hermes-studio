# Changelog

## [0.6.0] - 2026-10-14

A warning before you hit a usage limit, and compressed chats that read better.

### Added

- **A count on the Agents tab** while Hermes's helper agents run, like the one on
  Learning. It goes down as each one finishes.
- **A warning before you hit a usage limit.** When 20% or less of your subscription is
  left for the current model, the model chip says so: "Opus 5.5 · 17% left" in amber,
  red from 10%. At the limit it says until when ("until 14:10"). Hover the chip for
  every limit; click it to switch to another model before you run out. Hermes Studio
  reads your usage again after each reply (at most once a minute; it costs no tokens).

### Changed

- **A compressed chat reads better when you open it again.** When Hermes compresses a
  long chat, it writes a summary of the older messages. Opening that session showed the
  summary as a long message; now it is one folded line, "Earlier messages were
  summarized", and a click shows the summary.
- **Updated the Agent Client Protocol SDK** (the library that talks to Hermes) from
  1.5.0 to 1.8.0. It now caps one message at 32 MB, so a broken stream can't fill the
  memory.

## [0.5.0] — 2026-09-29

Answer Hermes's memory changes and get new skills without leaving VS Code.

### Added

- **Answer memory changes in the Memory tab.** Each change Hermes wants to make to its
  memory has **Approve** and **Reject** buttons: no more typing `/memory pending` in the
  Hermes CLI. A rewrite shows what the entry says now. When Hermes proposed several
  versions of the same rewrite, they show as one card: pick one and click **Use this
  one** (the others go), or **Reject all**. **Reject all** at the top asks once more.
  Hermes Studio runs Hermes's own approve and reject, exactly as `/memory` does; an
  approved change counts from your next new chat. A change Hermes can't apply any more
  is marked **outdated** and offers only Reject: one made by an older Hermes, or one
  whose entry has changed since Hermes proposed it (Hermes checks the entry word for
  word, so Hermes Studio checks it the same way before you click).
- **Get more skills in the Capabilities tab.** **Installed | Get more**: Get more lists
  Hermes's official skills, and searches the whole Skills Hub. Each skill shows where it
  comes from and how trusted it is (★ Official, Trusted, Community). **Install** runs
  Hermes's own install: Hermes checks the skill for risky code first and refuses a risky
  one, and the tab says why. A new skill works from your next new chat.
- **A refresh button** (↻) in the Memory and Capabilities tabs: read Hermes's files again.

### Fixed

- **A skill added as a folder link** (for example into `~/.agents/skills`) now shows up
  in Capabilities and the "/" list without reloading the window.

## [0.4.1] — 2026-09-29

### Changed

- **The name is now Hermes Studio.** It is still a community extension, not made by Nous
  Research; the page says so.
- **A friendlier Marketplace page:** what you need before you start (Hermes Agent), how to
  get going, what you can do, and answers to common questions.

## [0.4.0] — 2026-09-29

Skills anywhere in a message, a better reply, and a logo. The first release on the Visual
Studio Marketplace.

### Added

- **A better reply:**
  - File paths Hermes writes in `code` (`pages/contact.html`, `src/a.ts:42`) that are real
    files turn gold, with a file icon, like "@file" mentions. A click opens the file (at the
    line). Hermes Studio checks each path first; a made-up one stays code.
  - Other inline code is a soft blue instead of grey on grey.
  - **Changed in this reply:** under a finished reply, the files its steps edited, with
    their +/− lines. A click opens the change as a diff.
  - A footer under each reply: how long it took, **Copy** (the whole reply) and, on the
    newest one, **Retry** (your message again; not for a message with files or images).
  - More space between paragraphs and list items.
- **A logo:** a winged H on Hermes blue with ASCII shading. It is the extension's icon and
  the logo on Windows notifications.

### Fixed

- **"/" for skills works anywhere in the message**, not only at its start. A picked skill
  stays where you typed it, as a gold `/skill-name`, and one message can name several:
  the list opens again for the next "/", and Hermes loads each one. The sent message shows
  them in gold too. Hermes's own commands (`/compress`, `/model`, …) are still offered only
  at the start, because Hermes runs a command only as the whole message. A path
  (`src/app`) or a URL is not taken for a skill.

## [0.3.0] — 2026-09-28

Send while Hermes works, an image lightbox, gold "@file" mentions, an effort slider, and
colours for the edit modes and Stop.

### Added

- **Send while Hermes works.** Enter (or the Queue button next to Stop) no longer does
  nothing while Hermes replies: the message waits in a "Queued" card above the composer,
  with the file you were in and any "+" chips, and goes out when the reply ends by itself.
  **Send now** hands a queued message to the reply Hermes is writing instead: Hermes takes
  a text-only message sent mid-turn as a correction and reads it at its next step. The chat
  shows it as its own bubble ("sent while Hermes worked"), with Hermes's words after it
  below. A message with a file or an image waits for the reply to end. ✏ puts a queued
  message back into the text box, × removes it. After Stop, a usage limit or an error, the
  queue waits for you (Send). New chat, another session or Restart gives queued messages
  back to the composer.

### Changed

- **The image preview is a lightbox:** the picture floats over the dimmed chat, with its
  name and size under it and a × on its corner. A click outside the picture, or Esc,
  closes it too.
- **"@file" mentions show in Hermes gold**, while you type and on the sent message. An
  e-mail address is not a mention.
- **Effort is a slider** in the modes pop-up: a point at every level, a thumb you drag that
  snaps onto the nearest point, and a colour per level (Low green, Medium blue, High
  yellow, Extra high orange, Max red). Hermes saves once, when you let go (← / → / Home /
  End work too), then shows "✓ Saved".
- **The composer's outline takes the edit mode's colour**, and so does the mode chip:
  Manual blue, Edit automatically purple, Auto orange.
- **Stop is red**, so it never looks like Send.

## [0.2.0] — 2026-09-28

The chat in an editor tab, notifications when Hermes needs you or is done, and skills whose
folder is a link.

### Added

- **The chat in an editor tab.** A button in the chat view's title bar (Open Chat in Editor
  Tab) moves the chat into an editor tab, with the same session, draft and chips. Over an
  editor tab VS Code shows its own "Hold Shift to drop into editor" hint while you drag a
  file. The tab has History, New chat and Move Chat to Side Bar in its title bar; closing it
  moves the chat back to the side bar. The side bar meanwhile says where the chat is, and
  its Learning, Memory, Capabilities and Agents tabs keep working. After a window reload
  the tab comes back. In a wide tab the conversation keeps a readable width.
- **Notifications when Hermes needs you, finishes or stops**, only while you are not
  looking at that chat. Inside VS Code: a notification when the chat is not on screen. On
  Windows: also a Windows notification while VS Code is not the front window ("Hermes needs
  your OK", "Hermes finished — took 2 min 14 s", "Hermes stopped — Claude usage limit"); a
  click brings VS Code back on that chat and its card. A notification never answers an
  approval: Show only takes you to the card. A count on the Hermes Studio view (and a
  marked icon on the chat's editor tab) says how many chats need you; the Sessions pop-up
  marks chats that finished or stopped while you were away until you open them. Nothing
  for a turn you stopped yourself. Settings: `hermesStudio.notifications` and
  `hermesStudio.windowsNotifications` (both on).
- **The file you are in stays while the chat covers it.** With the chat's tab in front of
  your file, the composer keeps that file (and its selection) while the file's tab is still
  open.

### Fixed

- **Skills whose folder is a link now show up.** A skill folder that is a symlink or a
  Windows junction (for example into `~/.agents/skills`) was missing from the "/" list and
  the Capabilities tab. A link to nothing is still left out.

## [0.1.0] — 2026-09-28

The first release: chat with Hermes in VS Code, its sessions, models, approvals and panels.

### Added

- **Chat with Hermes in the secondary side bar.** Hermes Studio starts `hermes acp` for the
  open folder and streams replies as Markdown with highlighted code blocks (Copy button).
  Each Hermes turn is labelled; its thinking is folded, and its tool calls share one "N
  steps" card that stays open while a step runs. A live line above the composer says what
  Hermes is doing and for how long. The header shows the session title, the folder and a
  status pill; the composer shows a context ring and the current model. Stop, New chat and
  Restart. Scrolling follows the reply until you scroll up. Every colour comes from the VS
  Code theme, so light and high-contrast themes work too.
- **Sessions per folder.** The Sessions pop-up (the History button, or a click on the chat
  title) lists the Hermes sessions started in this folder, newest first, with search, arrow
  keys and "Show more". Opening one replays its history into the chat and continues in that
  session. The empty chat offers the three most recent. Hermes is the only store: nothing
  is saved in VS Code.
- **Rename and delete a session** from the pop-up: ✏ and 🗑 on the highlighted row (or F2 /
  Del). Hermes keeps names unique and at most 100 characters. Delete asks first; Hermes
  deletes the session and all its messages, with no undo.
- **Chats keep working in the background.** Opening another session, or a New chat, while
  Hermes works no longer stops the reply: Hermes goes on with it (up to 4 at once). The
  Sessions pop-up lists it on top as "working", and going back shows everything it did
  meanwhile. An approval it asks for is never answered for you: a notice says "Hermes needs
  your OK in …", with Show.
- **Switch models in the same session.** The composer's model chip opens a menu of every
  model Hermes can use (search, grouped by provider, keyboard). Switching keeps the
  conversation.
- **Modes and effort in one pop-up.** **Manual** (ask before each edit), **Edit
  automatically** (edit files in this folder without asking) or **Auto** (edit any file
  without asking); in every mode, sensitive files and risky commands still ask. The same
  pop-up sets Hermes's reasoning **Effort** (Low to Max). Hermes has no per-chat effort in
  editor mode, so this is its global setting: it applies from the next new chat, in all of
  Hermes.
- **Context details.** A click on the context ring shows the tokens used, how full the
  window is, where Hermes compresses the chat, the messages by who wrote them, and the
  model. It comes from Hermes's `/context`, a local command: no tokens, nothing added to the
  chat. **Compress now** sends `/compress` (which does use the model).
- **The file you are in goes along.** The composer shows the file you are working in
  ("login.ts", or "login.ts 40–52" with a selection) and sends Hermes its path and line, or
  the selected lines, never the whole file. × leaves it out until you move to another file.
- **Subscription usage in the model menu.** Each provider with a subscription shows how
  much of it is used, with a bar (amber from 70%, red from 90%), from `hermes usage`. When
  a subscription is used up, its models are dimmed and show when it resets. It spends no
  tokens. Hermes 0.21.5 shows Claude's 1% as 100% (Hermes bug #58226); Hermes Studio
  corrects that while the installed Hermes still has the bug.
- **Usage limits.** When a provider gives up (usage or rate limit, credits used up,
  overloaded), a banner says so, with the reset time, and offers "Continue with" a model
  from another provider: one click switches and sends the message again, in the same
  session.
- **Approvals in the chat.** Hermes's edit and risky-command approvals are cards in the
  conversation: the file with its whole change as a diff (Open diff for the side-by-side
  view), or the exact command with Hermes's reason. Deny is the first button and a card
  never takes focus by itself, so typing can never approve. Invisible and bidi characters
  are shown as escapes. A card records its outcome (allowed, denied, timed out or
  cancelled), and a late click does nothing.
- **Hermes panels.** A Hermes icon in the activity bar opens read-only views over Hermes's
  own files: **Learning** (skills Hermes created or improved, each change as a diff),
  **Curator** (on or paused, last run with its report, next run), **Memory** (your notes and
  profile, and proposals waiting for your OK), **Capabilities** (skills by source, MCP
  connectors, plugins) and **Agents** (background subagents of the last 7 days, with their
  logs). A SKILL.md opened in the editor says when Hermes learned it. Nothing starts or
  changes Hermes, and credentials are never read.
- **The panels as tabs in the chat view too:** Chat · Learning · Memory · Capabilities ·
  Agents. The chat keeps running under the other tabs: the Chat tab gets a dot while Hermes
  works and a warning dot while an approval waits.
- **Add to the message.** The composer's **+** adds files, the editor selection, VS Code's
  errors and warnings, the uncommitted git changes, or an image (pick one, or paste it).
  Each shows as a chip you can remove before sending. An image chip shows a thumbnail;
  click it to see the picture.
- **"/" for skills** lists Hermes's skills, then Hermes's own commands. Hermes Studio asks
  Hermes to load a picked skill with its `skill_view` tool, so Hermes counts the skill as
  used and applies its templates and files, as its terminal does.
- **"@" to add a file** lists the workspace's files and folders; a picked file is attached.
- **Drop files into the chat.** Hold Shift and drop files from the Explorer or an editor tab
  onto the composer. Pictures dropped from outside VS Code work too.
- **"Hermes learned …" on the empty chat:** what Hermes learned this week and when its
  curator last ran. It opens the Learning tab.
- **Step details.** A step in the "N steps" card opens to show what the tool reported, its
  diff for edits, and the files it touched.
- **Robust lifecycle.** New chat during a running turn keeps its late output out of the new
  chat. Stopping a message before Hermes is ready withdraws it. Shutdown stops Hermes and
  everything it started. A crash is reported; three in a minute stop auto-restarts.
- **Setup flow.** A Hermes with no model provider shows "Setup needed"; Run setup opens
  `hermes model` in a terminal and restarts Hermes when it closes.
