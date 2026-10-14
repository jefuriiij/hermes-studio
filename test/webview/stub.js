// Stands in for VS Code around the webview bundle: defines acquireVsCodeApi()
// and plays a scripted host. serve.mjs inlines this file into a <script> that
// carries the page nonce and runs BEFORE the module, exactly where VS Code's
// own api script would be. Everything it sees lands on window.__hs for the
// Playwright checks.
//
// Input: window.__HS__ = { fixture, theme, options } (set by serve.mjs).
(() => {
  const { fixture, theme, options } = window.__HS__;

  // --- theme: what VS Code puts on <body> and <html> -----------------------
  document.body.className = theme.bodyClass;
  if (options.reduceMotion) document.body.classList.add("vscode-reduce-motion");
  document.body.dataset.vscodeThemeKind = theme.kind;
  document.body.dataset.vscodeThemeId = theme.name;
  const rootStyle = document.documentElement.style;
  for (const [k, v] of Object.entries(theme.vars)) rootStyle.setProperty(k, v);
  // The app keeps <body> transparent (the view pane paints behind the iframe
  // in VS Code); paint that pane colour here. CSSOM, so the CSP allows it.
  // ?place=editor: the chat in an editor tab, on the editor's colour.
  const inEditor = document.body.dataset.place === "editor";
  rootStyle.background =
    theme.vars[inEditor ? "--vscode-editor-background" : "--vscode-sideBar-background"];

  // --- recorder ------------------------------------------------------------
  const hs = {
    posted: [],
    violations: [],
    errors: [],
    alerts: [],
    // ?draft=… simulates state VS Code kept from an earlier session.
    state:
      typeof options.draft === "string" || typeof options.tab === "string"
        ? { draft: options.draft ?? "", ...(options.tab ? { tab: options.tab } : {}) }
        : undefined,
    acquired: 0,
    done: false,
  };
  window.__hs = hs;
  document.addEventListener("securitypolicyviolation", (e) => {
    hs.violations.push(`${e.violatedDirective} ${e.blockedURI} ${(e.sample || "").slice(0, 80)}`);
  });
  window.addEventListener("error", (e) => hs.errors.push(String(e.message)));
  // If the XSS payload ever executed, this is where it would show up.
  window.alert = (m) => hs.alerts.push(String(m));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms * options.speed));
  // VS Code delivers host messages as `message` events on the webview window —
  // after a JSON round trip (the extension host serializes with JSON.stringify).
  // Round-trip here too: structured clone would keep `undefined` values that
  // VS Code drops, and hide exactly that class of host/webview drift.
  const deliver = (msg) => window.postMessage(JSON.parse(JSON.stringify(msg)), "*");
  hs.deliver = deliver;

  const lines = (t) => (Array.isArray(t) ? t.join("\n") : t);

  let turn = 0;
  async function play() {
    for (const step of fixture.steps) {
      if (step.delay) await sleep(step.delay);
      if (step.msg) {
        if (step.msg.type === "init") turn = step.msg.model.meta.turn;
        if (step.msg.type === "ops") {
          for (const o of step.msg.ops) if (o.op === "meta" && o.patch.turn) turn = o.patch.turn;
        }
        deliver(step.msg);
      } else if (step.stream) {
        const { id, chunk, every } = step.stream;
        const text = lines(step.stream.text);
        for (let i = 0; i < text.length; i += chunk) {
          deliver({ type: "ops", ops: [{ op: "append", id, text: text.slice(i, i + chunk) }] });
          if (every) await sleep(every);
        }
      }
    }
    // Let the last message be handled and rendered before reporting done.
    await new Promise((r) => setTimeout(r, 50));
    hs.done = true;
  }

  // A few host reactions, so Send/Stop/New chat can be exercised end to end.
  let echoId = 0;
  // The "+" list, owned by the host (as AttachmentService does).
  let chips = [];
  const SAMPLE = {
    file: { label: "auth.ts", detail: "src/auth.ts" },
    image: { label: "screenshot.png", detail: "image/png · 212 KB" },
    selection: { label: "login.ts 40–52", detail: "src/routes/login.ts, lines 40–52" },
    problems: { label: "Problems (2)", detail: "1 errors, 1 warnings" },
    git: { label: "Git changes (3 files)", detail: "staged and unstaged" },
  };
  const sendChips = () => deliver({ type: "context", items: chips, images: true });
  // The file you are in (?editor=0: none open) and Hermes's effort setting.
  let editorExcluded = false;
  let effortValue = "high";
  const sendEditor = () =>
    deliver({
      type: "editorContext",
      file:
        new URLSearchParams(location.search).get("editor") === "0"
          ? null
          : {
              label: "login.ts 40–52",
              detail: "Hermes sees src/auth/login.ts and your selection (lines 40–52).",
              excluded: editorExcluded,
            },
    });
  // Image data by chip id, as the host keeps it (the webview gets it on click).
  const pictures = new Map();
  /** A stand-in "screenshot": a canvas painted with a gradient and a label. */
  function samplePicture(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "#1f6feb");
    grad.addColorStop(1, "#d97757");
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff";
    g.font = "bold 28px sans-serif";
    g.fillText(`${w}×${h}`, 20, 48);
    return c.toDataURL("image/png").split(",")[1];
  }
  // The Hermes panels (tabs), as logic/panelTabs.ts builds them. ?panels=0:
  // Hermes's folder not found.
  const hoursAgo = (h) => Date.now() - h * 3_600_000;
  let unseen = 2;
  // Memory proposals answered in the tab (they leave the list), and skills
  // installed from the hub (they join Installed).
  const answered = new Set();
  const hubInstalled = [];
  const H = "C:/Users/sam/AppData/Local/hermes";
  const panelsView = () => ({
    found: new URLSearchParams(location.search).get("panels") !== "0",
    home: H,
    learning: {
      newThisWeek: 2,
      improvedThisWeek: 4,
      learnedTotal: 14,
      skillsTotal: 107,
      unseen,
      totalChanges: 224,
      firstChangeAt: hoursAgo(24 * 32),
      allChanges: "allChanges",
      items: [
        {
          skill: "windows-path-quoting",
          kind: "new",
          description:
            "Quote Windows paths with spaces in PowerShell, cmd and Node child_process calls.",
          lastChangeAt: hoursAgo(2),
          changes: 1,
          open: `file:0:${H}/skills/devops/windows-path-quoting/SKILL.md`,
          diff: { key: "change:e1", added: 38, removed: 0 },
          history: "history:windows-path-quoting",
          session: { key: "session:s-current", title: "Fix the login redirect after OAuth" },
        },
        {
          skill: "acp-session-replay",
          kind: "new",
          description: "Rebuild turns from a session/load replay; ids per kind.",
          lastChangeAt: hoursAgo(26),
          changes: 1,
          open: `file:0:${H}/skills/software-development/acp-session-replay/SKILL.md`,
          history: "history:acp-session-replay",
          session: { key: "session:s-roster", title: "Sessions per folder" },
        },
        {
          skill: "svelte5-runes",
          kind: "improved",
          lastChangeAt: hoursAgo(28),
          changes: 3,
          open: `file:0:${H}/skills/software-development/svelte5-runes/SKILL.md`,
          diff: { key: "change:e3", added: 14, removed: 3 },
          history: "history:svelte5-runes",
        },
        {
          skill: "hubspot-module-builder",
          kind: "improved",
          lastChangeAt: hoursAgo(24 * 4),
          changes: 1,
          diff: { key: "change:e4", added: 2, removed: 0 },
          history: "history:hubspot-module-builder",
        },
      ],
    },
    curator: {
      state: "on",
      every: "weekly",
      lastRunAt: hoursAgo(24 * 4),
      summary: "1 marked stale",
      nextRunAt: Date.now() + 3 * 86_400_000,
      minIdleHours: 2,
      report: "file:0:report",
      consolidate: false,
    },
    memory: {
      notes: {
        chars: 1834,
        limit: 2200,
        open: "file:0:MEMORY.md",
        entries: [
          "A release is package.json + CHANGELOG + git tag, together.",
          "Hermes Studio webview: Svelte 5 + Tailwind v4, colours only from VS Code theme tokens.",
          "On Windows, stop hermes.exe with taskkill /T /F; the launcher leaves its children running.",
          "Never open auth.json or .env under HERMES_HOME.",
          "Sam tests every change in VS Code before a commit.",
          "<img src=x onerror=alert(1)> is text, never HTML.",
        ].map((text, i) => ({ text, key: `file:${i * 2 + 1}:MEMORY.md` })),
      },
      profile: {
        chars: 880,
        limit: 1375,
        open: "file:0:USER.md",
        entries: [
          "Developer. Windows 11, PowerShell and VS Code.",
          "Tests each change by hand before a commit.",
        ].map((text, i) => ({ text, key: `file:${i * 2 + 1}:USER.md` })),
      },
      pending: [
        {
          id: "p1",
          action: "add",
          target: "memory",
          text: "The project now lives in C:\\Users\\sam\\code\\my-app on the laptop.",
          more: 0,
          createdAt: hoursAgo(2),
          stale: false,
          key: "pending:p1",
        },
        {
          id: "p2",
          action: "replace",
          target: "user",
          text: "Prefers short replies in plain words, with at most two options.",
          more: 0,
          createdAt: hoursAgo(24 * 7),
          stale: true,
          key: "pending:p2",
        },
        // Two versions of one rewrite (mock board 27A): offered as one choice.
        ...["p3", "p4"].map((id, i) => ({
          id,
          action: "replace",
          target: "user",
          text: [
            "One design language in UI: a set radius (no fully rounded pills), one accent colour on hover, darker borders on light backgrounds.",
            "UI language: set radius (no full pills), one accent colour on hover, subtle hovers at ~.15s ease.",
          ][i],
          more: 0,
          createdAt: hoursAgo(1 + i * 20),
          // ?outdated=1: the entry changed since (Hermes would refuse both).
          ...(new URLSearchParams(location.search).get("outdated") === "1"
            ? { stale: true, changed: true }
            : { stale: false }),
          key: `pending:${id}`,
          replaces:
            "One design language in UI: no fully rounded pills (a set radius), one accent colour on hover, subtle over flashy.",
          group: "pin:p3",
        })),
      ].filter((p) => !answered.has(p.id)),
    },
    capabilities: {
      skills: [
        [
          "windows-path-quoting",
          "devops",
          "Quote Windows paths with spaces in PowerShell, cmd and Node child_process calls.",
          "learned",
        ],
        [
          "acp-session-replay",
          "software-development",
          "Rebuild turns from a session/load replay; ids per kind.",
          "learned",
        ],
        [
          "svelte5-runes",
          "software-development",
          "Svelte 5 runes: $state, $derived, $effect and $props.",
          "learned",
        ],
        [
          "hubspot-module-builder",
          "web",
          "Build HubSpot CMS modules: fields.json, module.html and meta.json.",
          "learned",
        ],
        ["threejs-scenes", "creative", "Set up three.js scenes, cameras and lights.", "hub"],
        ["pdf", undefined, "Read, merge and split PDF files.", "builtin"],
        [
          "git-workflows",
          "software-development",
          "Branches, rebases and clean histories.",
          "builtin",
        ],
        ...hubInstalled.map((n) => [n, undefined, "From the Skills Hub.", "hub"]),
      ].map(([name, category, description, source]) => ({
        name,
        ...(category ? { category } : {}),
        description,
        source,
        key: `file:0:${H}/skills/${name}/SKILL.md`,
      })),
      mcp: [
        { name: "playwright", transport: "stdio · npx", enabled: true },
        { name: "chrome-devtools", transport: "stdio · npx", enabled: true },
      ],
      plugins: [],
    },
    agents: {
      running: [
        {
          id: "deleg_1",
          goal: "Compare the Codex and Claude usage APIs",
          startedAt: hoursAgo(0.04),
          failed: false,
          tasks: [
            {
              goal: "Read the Anthropic OAuth usage response",
              status: "completed",
              key: "file:0:t1.log",
            },
            { goal: "Read the Codex usage response", status: "running", key: "file:0:t2.log" },
            { goal: "Write the comparison" },
          ],
        },
      ],
      recent: [
        {
          id: "deleg_2",
          goal: "Research ACP session resume",
          startedAt: hoursAgo(24 * 5),
          completedAt: hoursAgo(24 * 5) + 180_000,
          failed: false,
          tasks: [
            { goal: "Read acp_adapter/server.py", status: "completed", key: "file:0:t3.log" },
            { goal: "Try session/resume with an unknown id", status: "completed" },
          ],
        },
        {
          id: "deleg_3",
          goal: "Find the open fix PRs for Hermes #58226",
          startedAt: hoursAgo(24 * 6),
          completedAt: hoursAgo(24 * 6) + 240_000,
          failed: true,
          tasks: [
            { goal: "Search the PRs", status: "completed" },
            { goal: "Read each diff", status: "failed" },
          ],
        },
      ],
    },
  });
  const sendPanels = () => deliver({ type: "panels", view: panelsView() });

  // The saved sessions, made once so a rename or a delete sticks.
  let sessionStore;
  function savedSessions() {
    if (sessionStore) return sessionStore;
    // Times relative to now, so every day group shows up.
    const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
    sessionStore = [
      [
        "s-current",
        "Fix the login redirect after the OAuth callback drops the returnTo parameter",
        2,
      ],
      ["s-roster", "Why does the roster page load twice?", 190],
      ["s-calendar", "Refactor the booking calendar", 60 * 26],
      ["s-photos", "Add horse photo uploads to the stable profile", 60 * 30],
      ["s-csv", "Stable roster CSV import", 60 * 24 * 3],
      ["s-emails", "Dark mode for the booking emails", 60 * 24 * 4],
      ["s-kit", "Upgrade SvelteKit to the latest release", 60 * 24 * 12],
    ].map(([id, title, min]) => ({ id, title, updatedAt: ago(min) }));
    return sessionStore;
  }

  function echo(m) {
    if (m.type === "ready") {
      // ?here=0: the side bar while the chat is in an editor tab.
      if (new URLSearchParams(location.search).get("here") === "0") {
        deliver({ type: "chatPlace", here: false });
      }
      sendChips();
      sendEditor();
      sendPanels();
      // ?summary=1: a saved session that Hermes had compressed: its summary
      // of the older messages comes first.
      if (new URLSearchParams(location.search).get("summary") === "1") {
        deliver({
          type: "ops",
          ops: [
            {
              op: "add",
              item: {
                kind: "summary",
                id: "summary~stub",
                turn: 0,
                text: "## Goal\nFix the login redirect after OAuth.\n\n## Done so far\n- `safeReturnTo` only follows same-site paths\n- 3 redirect tests pass",
              },
            },
          ],
        });
      }
      // ?low=83: the host read Claude at 83% used after a reply (the model
      // chip warns from 80%).
      const low = Number(new URLSearchParams(location.search).get("low"));
      if (low > 0) {
        const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
        deliver({
          type: "accountUsage",
          usage: {
            loading: [],
            byProvider: {
              anthropic: {
                windows: [
                  { label: "Current session", usedPercent: low, resetsAt: inHours(2.9) },
                  { label: "Current week", usedPercent: 41, resetsAt: inHours(24 * 5) },
                ],
                details: [],
                fetchedAt: new Date().toISOString(),
              },
            },
          },
        });
      }
      // Hermes's own slash commands, as available_commands_update gives them.
      deliver({
        type: "ops",
        ops: [
          {
            op: "meta",
            patch: {
              commands: [
                { name: "help", description: "List available commands" },
                { name: "model", description: "Show current model and provider, or switch models" },
                { name: "tools", description: "List available tools with descriptions" },
                { name: "context", description: "Show conversation message counts by role" },
                { name: "reset", description: "Clear conversation history" },
                { name: "compress", description: "Compress conversation context" },
                {
                  name: "queue",
                  description: "Queue a prompt to run after the current turn finishes",
                },
                { name: "version", description: "Show Hermes version" },
              ],
            },
          },
        ],
      });
      // ?bg=1: two chats working in the background, and the Sessions pop-up open.
      if (new URLSearchParams(location.search).get("bg") === "1") {
        deliver({
          type: "background",
          sessions: [
            { id: "s-bg-new", title: "Test message", state: "working" },
            { id: "s-roster", title: "Why does the roster page load twice?", state: "waiting" },
          ],
        });
        setTimeout(() => deliver({ type: "showSessions" }), 50);
      }
    } else if (m.type === "checkPaths") {
      // Which `code` paths are real files: all of them here, except a name
      // with "missing" in it.
      deliver({
        type: "paths",
        known: Object.fromEntries(m.paths.map((p) => [p, !p.includes("missing")])),
      });
    } else if (m.type === "moveChatHere") {
      deliver({ type: "chatPlace", here: true });
    } else if (m.type === "panelSeen") {
      unseen = 0;
      sendPanels();
    } else if (m.type === "refreshPanels") {
      setTimeout(sendPanels, 100);
    } else if (m.type === "memoryReview") {
      // ?review=fail: Hermes refuses the approve.
      const fail = new URLSearchParams(location.search).get("review") === "fail";
      const ids = [...(m.approve ? [m.approve] : []), ...m.reject];
      setTimeout(() => {
        if (fail && m.approve) {
          deliver({
            type: "memoryReviewed",
            ids,
            ok: false,
            message: "Hermes couldn't apply it: the entry this change was reviewed against is gone",
          });
          return;
        }
        for (const id of ids) answered.add(id);
        deliver({ type: "memoryReviewed", ids, ok: true });
        sendPanels();
      }, 600);
    } else if (m.type === "hubSearch") {
      const all = [
        [
          "dynamic-workflow",
          "official/autonomous-ai-agents/dynamic-workflow",
          "official",
          "official",
          "Plan-in-code fan-outs, adversarial verification, waves.",
        ],
        [
          "antigravity-cli",
          "official/autonomous-ai-agents/antigravity-cli",
          "official",
          "official",
          "Operate the Antigravity CLI (agy): plugins, auth, sandbox.",
        ],
        [
          "git-workflows",
          "official/software-development/git-workflows",
          "official",
          "official",
          "Branches, rebases and clean histories.",
        ],
        [
          "pdf",
          "anthropics/skills/skills/pdf",
          "github",
          "trusted",
          "Read, merge, split, fill and create PDF files; OCR scanned ones.",
        ],
        [
          "pdf-forms-lite",
          "skills-sh/someone/skills/pdf-forms-lite",
          "skills.sh",
          "community",
          "Fill PDF forms from a JSON file.",
        ],
      ].map(([name, identifier, source, trust, description]) => ({
        name,
        identifier,
        source,
        trust,
        description,
      }));
      const q = m.query.trim().toLowerCase();
      const items = all.filter(
        (s) =>
          (m.official ? s.trust === "official" : true) &&
          (!q || s.name.includes(q) || s.description.toLowerCase().includes(q)),
      );
      setTimeout(() => deliver({ type: "hubResults", seq: m.seq, items }), 500);
    } else if (m.type === "hubInstall") {
      setTimeout(() => {
        if (m.identifier.includes("forms")) {
          deliver({
            type: "hubInstalled",
            identifier: m.identifier,
            ok: false,
            message: "Not installed: Hermes's safety check found risky code in it.",
          });
          return;
        }
        hubInstalled.push(m.identifier.split("/").pop());
        deliver({ type: "hubInstalled", identifier: m.identifier, ok: true });
        sendPanels();
      }, 1500);
    } else if (m.type === "toggleEditorContext") {
      editorExcluded = !editorExcluded;
      sendEditor();
    } else if (m.type === "contextInfo") {
      setTimeout(
        () =>
          deliver({
            type: "contextInfo",
            info: {
              messages: 14,
              byRole: { user: 6, assistant: 6, tool: 2 },
              model: "claude-opus-5-5",
              used: 29_123,
              size: 1_000_000,
              threshold: 800_000,
              thresholdPct: 80,
              compressIn: 770_877,
              autoCompress: true,
            },
          }),
        150,
      );
    } else if (m.type === "refreshEffort") {
      deliver({ type: "effort", effort: { value: effortValue, loading: false, saving: false } });
    } else if (m.type === "setEffort") {
      effortValue = m.level;
      deliver({ type: "effort", effort: { value: effortValue, loading: false, saving: true } });
      setTimeout(
        () =>
          deliver({
            type: "effort",
            effort: { value: effortValue, loading: false, saving: false },
          }),
        600,
      );
    } else if (m.type === "addContext") {
      const id = `ctx~${++echoId}`;
      const extra = m.kind === "image" ? { size: "461×398" } : {};
      if (m.kind === "image")
        pictures.set(id, { mimeType: "image/png", data: samplePicture(461, 398) });
      chips = [...chips, { id, kind: m.kind, ...SAMPLE[m.kind], ...extra }];
      sendChips();
    } else if (m.type === "removeContext") {
      chips = chips.filter((c) => c.id !== m.id);
      sendChips();
    } else if (m.type === "pasteImage") {
      const kb = Math.round((m.data.length * 3) / 4 / 1024);
      const id = `ctx~${++echoId}`;
      pictures.set(id, { mimeType: m.mimeType, data: m.data });
      chips = [
        ...chips,
        { id, kind: "image", label: "Pasted image", detail: `${m.mimeType} · ${kb} KB` },
      ];
      sendChips();
    } else if (m.type === "refreshUsage") {
      // Like the host: "checking…" first, then Claude used up and Codex at 38%.
      // ?usage=0 answers "no usage" for every provider.
      const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
      deliver({
        type: "accountUsage",
        usage: { byProvider: {}, loading: ["anthropic", "openai-codex", "custom"] },
      });
      setTimeout(() => {
        const none = new URLSearchParams(location.search).get("usage") === "0";
        deliver({
          type: "accountUsage",
          usage: {
            loading: [],
            byProvider: none
              ? { anthropic: null, "openai-codex": null, custom: null }
              : {
                  anthropic: {
                    windows: [
                      { label: "Current session", usedPercent: 100, resetsAt: inHours(2.9) },
                      { label: "Current week", usedPercent: 41, resetsAt: inHours(24 * 5) },
                    ],
                    details: [],
                    fetchedAt: new Date().toISOString(),
                  },
                  "openai-codex": {
                    plan: "Plus",
                    windows: [
                      { label: "Session", usedPercent: 38, resetsAt: inHours(4) },
                      { label: "Weekly", usedPercent: 12, resetsAt: inHours(24 * 6) },
                    ],
                    details: ["You have 1 reset banked - use /usage reset to activate"],
                    fetchedAt: new Date().toISOString(),
                  },
                  custom: null,
                },
          },
        });
      }, 400);
    } else if (m.type === "previewImage") {
      const pic = pictures.get(m.id);
      const chip = chips.find((c) => c.id === m.id);
      setTimeout(() => {
        deliver({
          type: "imagePreview",
          id: m.id,
          image: pic ? { label: chip?.label ?? "Image", size: chip?.size, ...pic } : null,
        });
      }, 120);
    } else if (m.type === "send") {
      turn += 1;
      const skillChip = m.skill ? [{ kind: "skill", label: m.skill }] : [];
      const fileChips = chips.map((c) =>
        c.kind === "image"
          ? { kind: c.kind, label: c.label, id: c.id, ...(c.size ? { size: c.size } : {}) }
          : { kind: c.kind, label: c.label },
      );
      const attachments = [...skillChip, ...fileChips];
      chips = [];
      sendChips();
      deliver({
        type: "ops",
        ops: [
          {
            op: "add",
            item: {
              kind: "user",
              id: `echo-u${++echoId}`,
              turn,
              text: m.text,
              ...(attachments.length ? { attachments } : {}),
            },
          },
          { op: "meta", patch: { busy: true, turn } },
        ],
      });
    } else if (m.type === "cancel") {
      deliver({
        type: "ops",
        ops: [
          { op: "meta", patch: { busy: false } },
          {
            op: "add",
            item: {
              kind: "notice",
              id: `echo-n${++echoId}`,
              turn,
              level: "warning",
              text: "Stopped. Hermes will prepend the stopped request to your next message — start a New chat to drop it.",
            },
          },
        ],
      });
    } else if (m.type === "newChat") {
      deliver({
        type: "ops",
        ops: [
          { op: "clear" },
          // null, as the real host sends: undefined would vanish in the round trip.
          { op: "meta", patch: { busy: false, title: null, usage: null, sessionId: "s-new" } },
        ],
      });
    } else if (m.type === "fileSearch") {
      // A small workspace, ranked like logic/fuzzy.ts (names first).
      const files = [
        "src/auth/login.ts",
        "src/auth/logout.ts",
        "src/auth/middleware.ts",
        "src/lib/logger.ts",
        "src/routes/booking.ts",
        "test/auth/login.logic.test.ts",
        "docs/blog/post.md",
        "README.md",
        "package.json",
      ];
      const q = m.query.toLowerCase();
      const name = (p) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
      const score = (p) =>
        !q
          ? 1
          : name(p).startsWith(q)
            ? 3
            : name(p).includes(q)
              ? 2
              : p.toLowerCase().includes(q)
                ? 1
                : 0;
      const items = files
        .map((path) => ({ path, s: score(path) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.path.length - b.path.length)
        .slice(0, 8)
        .map(({ path }) => ({ path, kind: "file" }));
      setTimeout(() => deliver({ type: "fileResults", seq: m.seq, items }), 40);
    } else if (m.type === "mentionFile") {
      const label = m.path.slice(m.path.lastIndexOf("/") + 1);
      if (!chips.some((c) => c.detail === m.path)) {
        chips = [...chips, { id: `ctx~${++echoId}`, kind: "file", label, detail: m.path }];
        sendChips();
      }
    } else if (m.type === "renameSession" || m.type === "deleteSession") {
      // Like `hermes sessions rename|delete`: names are unique.
      const all = savedSessions();
      const s = all.find((x) => x.id === m.sessionId);
      let result;
      if (!s) {
        result = { ok: false, message: "Hermes no longer has that session." };
      } else if (m.type === "renameSession") {
        if (all.some((x) => x.id !== s.id && x.title === m.title.trim())) {
          result = { ok: false, message: "Another session already has that name." };
        } else {
          s.title = m.title.trim();
          result = { ok: true, message: "Renamed." };
        }
      } else {
        all.splice(all.indexOf(s), 1);
        result = { ok: true, message: `Deleted “${s.title}”.` };
      }
      setTimeout(() => {
        deliver({
          type: "sessionAction",
          result: {
            action: m.type === "renameSession" ? "rename" : "delete",
            sessionId: m.sessionId,
            ...result,
          },
        });
        deliver({
          type: "sessions",
          list: { items: all.slice(0, 6), nextCursor: "s-emails", loading: false },
        });
      }, 300);
    } else if (m.type === "listSessions") {
      const all = savedSessions();
      deliver({ type: "sessions", list: { items: [], loading: true } });
      setTimeout(() => {
        const list = m.cursor
          ? { items: all, loading: false }
          : { items: all.slice(0, 6), nextCursor: "s-emails", loading: false };
        deliver({ type: "sessions", list });
      }, 150);
    } else if (m.type === "setModel") {
      // Like the host: "Switching…" for a moment, then the new model + a notice.
      const label = m.modelId.split(":").slice(1).join(":") || m.modelId;
      deliver({ type: "ops", ops: [{ op: "meta", patch: { switchingModel: label } }] });
      setTimeout(() => {
        deliver({
          type: "ops",
          ops: [
            { op: "meta", patch: { switchingModel: null, model: label, modelId: m.modelId } },
            {
              op: "add",
              item: {
                kind: "notice",
                id: `echo-n${++echoId}`,
                turn,
                level: "info",
                text: `Switched to ${label}. The conversation continues with it.`,
              },
            },
          ],
        });
      }, 800);
    } else if (m.type === "setMode") {
      deliver({ type: "ops", ops: [{ op: "meta", patch: { mode: m.modeId } }] });
    } else if (m.type === "openSession") {
      turn = 1;
      deliver({
        type: "ops",
        ops: [
          { op: "clear" },
          {
            op: "meta",
            patch: { turn: 1, sessionId: m.sessionId, title: `Session ${m.sessionId}` },
          },
          {
            op: "add",
            item: { kind: "user", id: `echo-u${++echoId}`, turn: 1, text: "(replayed prompt)" },
          },
          {
            op: "add",
            item: {
              kind: "assistant",
              id: `echo-a${++echoId}`,
              turn: 1,
              text: "(replayed answer)",
            },
          },
        ],
      });
    }
  }

  window.acquireVsCodeApi = () => {
    // Same rule as VS Code: one acquisition per document.
    if (hs.acquired++ > 0)
      throw new Error("An instance of the VS Code API has already been acquired");
    return {
      postMessage(m) {
        hs.posted.push(structuredClone(m));
        if (m?.type === "ready" && options.play) void play();
        if (options.echo) echo(m);
      },
      getState: () => hs.state,
      setState: (s) => {
        hs.state = s;
        return s;
      },
    };
  };
})();
