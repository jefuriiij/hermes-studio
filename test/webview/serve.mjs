// Browser harness for the webview bundle (plan §11.4). Serves the BUILT
// dist/webview under the exact HTML and CSP the extension ships — the page is
// src/logic/html.ts's buildHtml(), not a copy — plus stub.js standing in for
// VS Code (acquireVsCodeApi, theme variables, a scripted host replaying
// fixture.json).
//
//   npx vite build
//   node test/webview/serve.mjs [--port 5199]
//
// Page options (query string):
//   theme=dark|light|hc   Dark Modern / Light Modern / High Contrast values
//   speed=1               delay multiplier for the fixture; 0 = no delays
//   play=0                do not replay the fixture after `ready`
//   echo=0                no fake host reactions to send/cancel/newChat
//   motion=reduce         add body.vscode-reduce-motion
//   draft=…               pretend VS Code restored this composer draft
//   tab=…                 pretend VS Code restored this tab (learning, memory, …)
//   panels=0              the host found no Hermes folder
//   bg=1                  two chats working in the background; opens the Sessions pop-up
//   place=editor          the page as an editor tab (the editor's background)
//   here=0                the side bar while the chat is in an editor tab

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const repo = resolve(here, "../..");
const dist = join(repo, "dist/webview");

if (!existsSync(join(dist, "webview.js"))) {
  console.error("dist/webview/webview.js is missing: run `npx vite build` first.");
  process.exit(1);
}

// Node 24 strips types natively, but this package is "type": "commonjs", so it
// loads a .ts file as CommonJS and chokes on `export`. Strip the types here and
// import the result as an ES module instead. A data: URL is enough because
// html.ts imports nothing; if it ever gains an import, this needs a loader.
const htmlTs = stripTypeScriptTypes(readFileSync(join(repo, "src/logic/html.ts"), "utf8"));
const { buildHtml } = await import(
  `data:text/javascript;base64,${Buffer.from(htmlTs).toString("base64")}`
);

const stubSource = readFileSync(join(here, "stub.js"), "utf8");
const fixture = JSON.parse(readFileSync(join(here, "fixture.json"), "utf8"));

const FONTS = {
  "--vscode-font-family": '"Segoe WPC", "Segoe UI", sans-serif',
  "--vscode-font-size": "13px",
  "--vscode-font-weight": "normal",
  "--vscode-editor-font-family": 'Consolas, "Courier New", monospace',
  "--vscode-editor-font-size": "14px",
  "--vscode-editor-font-weight": "normal",
};

// Values from VS Code 1.139's theme-defaults (dark_modern.json /
// light_modern.json / hc_black.json), with the workbench's registered defaults
// for colours a theme file leaves out (e.g. chat.requestBubbleBackground =
// editor.selectionBackground at 30%). A representative set, not every colour.
const THEMES = {
  dark: {
    name: "Default Dark Modern",
    kind: "vscode-dark",
    bodyClass: "vscode-dark",
    vars: {
      ...FONTS,
      "--vscode-foreground": "#cccccc",
      "--vscode-descriptionForeground": "#9d9d9d",
      "--vscode-focusBorder": "#0078d4",
      "--vscode-errorForeground": "#f85149",
      "--vscode-sideBar-background": "#181818",
      // The charts palette as VS Code 1.139 resolves it: orange is the find
      // highlight, a third opaque (lib/levels.ts must not use it).
      "--vscode-charts-red": "#f14c4c",
      "--vscode-charts-blue": "#3794ff",
      "--vscode-charts-yellow": "#cca700",
      "--vscode-charts-orange": "#ea5c0055",
      "--vscode-charts-green": "#89d185",
      "--vscode-charts-purple": "#b180d7",
      "--vscode-editor-background": "#1f1f1f",
      "--vscode-button-background": "#0078d4",
      "--vscode-statusBarItem-errorBackground": "#c72e0f",
      "--vscode-statusBarItem-errorForeground": "#ffffff",
      "--vscode-button-foreground": "#ffffff",
      "--vscode-button-hoverBackground": "#026ec1",
      "--vscode-button-border": "#ffffff1a",
      "--vscode-button-secondaryBackground": "#00000000",
      "--vscode-button-secondaryForeground": "#cccccc",
      "--vscode-button-secondaryHoverBackground": "#2b2b2b",
      "--vscode-input-background": "#313131",
      "--vscode-input-border": "#3c3c3c",
      "--vscode-input-foreground": "#cccccc",
      "--vscode-input-placeholderForeground": "#989898",
      "--vscode-textLink-foreground": "#4daafc",
      "--vscode-textLink-activeForeground": "#4daafc",
      "--vscode-textCodeBlock-background": "#2b2b2b",
      "--vscode-textPreformat-background": "#3c3c3c",
      "--vscode-textPreformat-foreground": "#d0d0d0",
      "--vscode-textBlockQuote-background": "#2b2b2b",
      "--vscode-textBlockQuote-border": "#616161",
      "--vscode-panel-border": "#2b2b2b",
      "--vscode-panelTitle-activeBorder": "#0078d4",
      "--vscode-panelTitle-activeForeground": "#cccccc",
      "--vscode-panelTitle-inactiveForeground": "#9d9d9d",
      "--vscode-activityBarBadge-background": "#0078d4",
      "--vscode-activityBarBadge-foreground": "#ffffff",
      "--vscode-widget-border": "#313131",
      "--vscode-widget-shadow": "#0000005c",
      "--vscode-editorWidget-background": "#202020",
      "--vscode-editorWidget-border": "#454545",
      "--vscode-progressBar-background": "#0078d4",
      "--vscode-toolbar-hoverBackground": "#5a5d5e50",
      "--vscode-list-hoverBackground": "#2a2d2e",
      "--vscode-list-activeSelectionBackground": "#04395e",
      "--vscode-list-activeSelectionForeground": "#ffffff",
      "--vscode-testing-iconPassed": "#73c991",
      "--vscode-editorWarning-foreground": "#cca700",
      "--vscode-editorInfo-foreground": "#59a4f9",
      "--vscode-chat-requestBackground": "#1f1f1f9e",
      "--vscode-chat-requestBubbleBackground": "#264f784d",
      "--vscode-chat-requestBorder": "#ffffff1a",
      "--vscode-debugTokenExpression-string": "#ce9178",
      "--vscode-debugTokenExpression-boolean": "#4e94ce",
      "--vscode-debugTokenExpression-number": "#b5cea8",
      "--vscode-debugTokenExpression-name": "#c586c0",
      "--vscode-symbolIcon-functionForeground": "#b180d7",
      "--vscode-symbolIcon-classForeground": "#ee9d28",
      "--vscode-symbolIcon-variableForeground": "#75beff",
      "--vscode-diffEditor-insertedTextBackground": "#9ccc2c33",
      "--vscode-diffEditor-removedTextBackground": "#ff000033",
    },
  },
  light: {
    name: "Default Light Modern",
    kind: "vscode-light",
    bodyClass: "vscode-light",
    vars: {
      ...FONTS,
      "--vscode-foreground": "#3b3b3b",
      "--vscode-descriptionForeground": "#3b3b3b",
      "--vscode-focusBorder": "#005fb8",
      "--vscode-errorForeground": "#f85149",
      "--vscode-sideBar-background": "#f8f8f8",
      "--vscode-charts-red": "#e51400",
      "--vscode-charts-blue": "#1a85ff",
      "--vscode-charts-yellow": "#bf8803",
      "--vscode-charts-orange": "#ea5c0055",
      "--vscode-charts-green": "#388a34",
      "--vscode-charts-purple": "#652d90",
      "--vscode-editor-background": "#ffffff",
      "--vscode-button-background": "#005fb8",
      "--vscode-statusBarItem-errorBackground": "#c72e0f",
      "--vscode-statusBarItem-errorForeground": "#ffffff",
      "--vscode-button-foreground": "#ffffff",
      "--vscode-button-hoverBackground": "#0258a8",
      "--vscode-button-border": "#0000001a",
      "--vscode-button-secondaryBackground": "#e5e5e5",
      "--vscode-button-secondaryForeground": "#3b3b3b",
      "--vscode-button-secondaryHoverBackground": "#cccccc",
      "--vscode-input-background": "#ffffff",
      "--vscode-input-border": "#cecece",
      "--vscode-input-foreground": "#3b3b3b",
      "--vscode-input-placeholderForeground": "#767676",
      "--vscode-textLink-foreground": "#005fb8",
      "--vscode-textLink-activeForeground": "#005fb8",
      "--vscode-textCodeBlock-background": "#f8f8f8",
      "--vscode-textPreformat-background": "#0000001f",
      "--vscode-textPreformat-foreground": "#3b3b3b",
      "--vscode-textBlockQuote-background": "#f8f8f8",
      "--vscode-textBlockQuote-border": "#e5e5e5",
      "--vscode-panel-border": "#e5e5e5",
      "--vscode-panelTitle-activeBorder": "#005fb8",
      "--vscode-panelTitle-activeForeground": "#3b3b3b",
      "--vscode-panelTitle-inactiveForeground": "#3b3b3b",
      "--vscode-activityBarBadge-background": "#005fb8",
      "--vscode-activityBarBadge-foreground": "#ffffff",
      "--vscode-widget-border": "#e5e5e5",
      "--vscode-widget-shadow": "#00000029",
      "--vscode-editorWidget-background": "#f8f8f8",
      "--vscode-editorWidget-border": "#c8c8c8",
      "--vscode-progressBar-background": "#005fb8",
      "--vscode-toolbar-hoverBackground": "#b8b8b850",
      "--vscode-list-hoverBackground": "#f2f2f2",
      "--vscode-list-activeSelectionBackground": "#e8e8e8",
      "--vscode-list-activeSelectionForeground": "#000000",
      "--vscode-testing-iconPassed": "#73c991",
      "--vscode-editorWarning-foreground": "#bf8803",
      "--vscode-editorInfo-foreground": "#0063d3",
      "--vscode-chat-requestBackground": "#ffffff9e",
      "--vscode-chat-requestBubbleBackground": "#add6ff4d",
      "--vscode-chat-requestBorder": "#0000001a",
      "--vscode-debugTokenExpression-string": "#a31515",
      "--vscode-debugTokenExpression-boolean": "#0000ff",
      "--vscode-debugTokenExpression-number": "#098658",
      "--vscode-debugTokenExpression-name": "#9b46b0",
      "--vscode-symbolIcon-functionForeground": "#652d90",
      "--vscode-symbolIcon-classForeground": "#d67e00",
      "--vscode-symbolIcon-variableForeground": "#007acc",
      "--vscode-diffEditor-insertedTextBackground": "#9ccc2c40",
      "--vscode-diffEditor-removedTextBackground": "#ff000033",
    },
  },
  hc: {
    name: "Default High Contrast",
    kind: "vscode-high-contrast",
    bodyClass: "vscode-high-contrast",
    vars: {
      ...FONTS,
      "--vscode-foreground": "#ffffff",
      "--vscode-descriptionForeground": "#ffffffb3",
      "--vscode-focusBorder": "#f38518",
      "--vscode-contrastBorder": "#6fc3df",
      "--vscode-contrastActiveBorder": "#f38518",
      "--vscode-errorForeground": "#f48771",
      "--vscode-sideBar-background": "#000000",
      "--vscode-editor-background": "#000000",
      "--vscode-button-background": "#000000",
      "--vscode-statusBarItem-errorBackground": "#b5200d",
      "--vscode-statusBarItem-errorForeground": "#ffffff",
      "--vscode-button-foreground": "#ffffff",
      "--vscode-button-border": "#6fc3df",
      "--vscode-button-secondaryForeground": "#ffffff",
      "--vscode-input-background": "#000000",
      "--vscode-input-border": "#6fc3df",
      "--vscode-input-foreground": "#ffffff",
      "--vscode-input-placeholderForeground": "#ffffffb3",
      "--vscode-textLink-foreground": "#21a6ff",
      "--vscode-textLink-activeForeground": "#21a6ff",
      "--vscode-textCodeBlock-background": "#000000",
      "--vscode-textPreformat-foreground": "#ffffff",
      "--vscode-textBlockQuote-border": "#ffffff",
      "--vscode-panel-border": "#6fc3df",
      "--vscode-panelTitle-activeBorder": "#f38518",
      "--vscode-panelTitle-activeForeground": "#ffffff",
      "--vscode-panelTitle-inactiveForeground": "#ffffff",
      "--vscode-activityBarBadge-background": "#000000",
      "--vscode-activityBarBadge-foreground": "#ffffff",
      "--vscode-widget-border": "#6fc3df",
      "--vscode-editorWidget-background": "#0c141f",
      "--vscode-editorWidget-border": "#6fc3df",
      "--vscode-progressBar-background": "#6fc3df",
      "--vscode-testing-iconPassed": "#73c991",
      "--vscode-editorWarning-foreground": "#ffd370",
      "--vscode-editorInfo-foreground": "#59a4f9",
      "--vscode-chat-requestBackground": "#0c141f",
      "--vscode-chat-requestBorder": "#6fc3df",
      "--vscode-debugTokenExpression-string": "#f48771",
      "--vscode-debugTokenExpression-boolean": "#75bdfe",
      "--vscode-debugTokenExpression-number": "#89d185",
      "--vscode-debugTokenExpression-name": "#ffffff",
      "--vscode-symbolIcon-functionForeground": "#b180d7",
      "--vscode-symbolIcon-classForeground": "#ee9d28",
      "--vscode-symbolIcon-variableForeground": "#75beff",
    },
  },
};

/** JSON that is safe inside a <script>: the fixture carries `</script>` on
 *  purpose (the XSS payload), which would otherwise end the stub early. */
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function page(origin, query) {
  const nonce = randomBytes(16).toString("base64");
  const html = buildHtml({
    cspSource: origin,
    nonce,
    scriptUri: `${origin}/webview.js`,
    styleUri: `${origin}/webview.css`,
    place: query.get("place") === "editor" ? "editor" : "side",
  });
  const speed = Number(query.get("speed") ?? "1");
  const boot = {
    fixture,
    theme: THEMES[query.get("theme") ?? "dark"] ?? THEMES.dark,
    options: {
      speed: Number.isFinite(speed) && speed >= 0 ? speed : 1,
      play: query.get("play") !== "0",
      echo: query.get("echo") !== "0",
      reduceMotion: query.get("motion") === "reduce",
      draft: query.get("draft") ?? undefined,
      tab: query.get("tab") ?? undefined,
    },
  };
  // The stub must run before the module and, under a nonce-only script-src,
  // must carry the same nonce — as VS Code's own injected api script would.
  const stub = `<script nonce="${nonce}">\nwindow.__HS__ = ${scriptJson(boot)};\n${stubSource}\n</script>\n`;
  const marker = '<script type="module"';
  if (!html.includes(marker)) {
    throw new Error("buildHtml() output changed: no module <script> to put the stub before");
  }
  return html.replace(marker, stub + marker);
}

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};
const ASSETS = new Set(["/webview.js", "/webview.css", "/webview.js.map"]);

const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 0;

const server = http.createServer(async (req, res) => {
  const origin = `http://${req.headers.host}`;
  const url = new URL(req.url ?? "/", origin);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(page(origin, url.searchParams));
    } else if (ASSETS.has(url.pathname)) {
      const body = await readFile(join(dist, url.pathname.slice(1)));
      const ext = url.pathname.slice(url.pathname.lastIndexOf("."));
      res.writeHead(200, { "content-type": TYPES[ext], "cache-control": "no-store" });
      res.end(body);
    } else if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err));
  }
});

server.listen(port, "127.0.0.1", () => {
  const { port: actual } = /** @type {import("node:net").AddressInfo} */ (server.address());
  console.log(`Hermes Studio webview harness: http://127.0.0.1:${actual}/?theme=dark`);
});
