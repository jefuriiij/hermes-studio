// Markdown for streamed, untrusted model output: marked → DOMPurify, with
// highlight.js core for code. Every string that reaches {@html} comes out of
// sanitize() below.
//
// Layers of defence, each enough on its own for the common case:
//   1. renderer.html escapes raw HTML, so `<script>` in a reply shows as text.
//   2. DOMPurify allows a short tag list: no style, img, iframe, form.
//   3. The CSP (src/logic/html.ts) runs nonce'd scripts only and loads no
//      remote images.
// Links never navigate: their href moves to data-href and a click is posted to
// the host, which opens http/https only (plan §8).

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked, type Token, type Tokens } from "marked";
import { pathRef } from "./paths";

// Core + a handful of languages keeps the bundle small; each definition brings
// its own aliases (ts/tsx, js, sh, ps1, py, html/svg, md, patch, yml).
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("yaml", yaml);

/** The last block is re-highlighted on every streamed batch; past this size a
 *  code block is shown plain rather than making each batch slower. */
const HIGHLIGHT_LIMIT = 60_000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** First word of the fence info string, if it looks like a language name. */
function fenceLang(info: string | undefined): string {
  const word = (info ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[\w#+.-]{1,32}$/.test(word) ? word.toLowerCase() : "";
}

function renderCode({ text, lang, escaped }: Tokens.Code): string {
  const l = fenceLang(lang);
  const code = text.replace(/\n$/, "");
  let body: string;
  if (escaped) body = code;
  else if (l && hljs.getLanguage(l) && code.length <= HIGHLIGHT_LIMIT) {
    body = hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
  } else body = escapeHtml(code);
  // The Copy button is wired by delegation (lib/delegate.ts), so this HTML
  // needs no script and survives being re-rendered while it streams.
  return (
    `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(l)}</span>` +
    `<button type="button" class="code-copy" aria-label="Copy code">Copy</button></div>` +
    `<pre><code class="hljs">${body}</code></pre></div>`
  );
}

const md = new Marked({
  gfm: true,
  async: false,
  renderer: {
    code: renderCode,
    // Raw HTML in model output is shown as text, never parsed.
    html({ text }) {
      return escapeHtml(text);
    },
    // Never load an image (the CSP would block a remote one anyway, and a
    // markdown image is the classic exfiltration channel). Offer it as a link
    // the user can choose to open instead of silently dropping it.
    image({ href, text }) {
      const label = text.trim() ? `image: ${text}` : "image";
      return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    // Runs after DOMPurify dropped unsafe URLs (javascript: etc.), so an empty
    // href here means "no link": leave plain text.
    const href = node.getAttribute("href");
    node.removeAttribute("href");
    if (href) {
      node.setAttribute("data-href", href);
      // Without href an <a> is neither focusable nor announced as a link.
      node.setAttribute("role", "link");
      node.setAttribute("tabindex", "0");
      if (!node.getAttribute("title")) node.setAttribute("title", href);
    }
  } else if (node.tagName === "INPUT") {
    // Only GFM task-list checkboxes are ever expected; make sure that is all.
    node.setAttribute("type", "checkbox");
    node.setAttribute("disabled", "");
  } else if (node.tagName === "BUTTON") {
    node.setAttribute("type", "button");
  } else if (node.tagName === "CODE" && node.parentElement?.tagName !== "PRE") {
    // Inline code that looks like a path (mock board 23): the page asks the
    // host whether it is a real file, and only then makes it a gold,
    // clickable pill (Markdown.svelte). Read from the text, never from HTML.
    const ref = pathRef(node.textContent ?? "");
    if (ref) {
      node.setAttribute("class", "md-path");
      node.setAttribute("data-path", ref.path);
      if (ref.line) node.setAttribute("data-line", String(ref.line));
    }
  }
});

const PURIFY = {
  ALLOWED_TAGS: [
    "p",
    "br",
    "strong",
    "em",
    "del",
    "code",
    "pre",
    "span",
    "div",
    "button",
    "ul",
    "ol",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "a",
    "hr",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "input",
  ],
  ALLOWED_ATTR: [
    "href",
    "title",
    "class",
    "type",
    "checked",
    "disabled",
    "align",
    "start",
    "aria-label",
  ],
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR: ["style"],
};

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, PURIFY) as string;
}

export interface Block {
  key: string;
  html: string;
}

/**
 * Block-level memoised rendering for one message. Finished blocks keep their
 * sanitized HTML, so while a reply streams only the block still being written
 * is parsed, highlighted and sanitized again — and Svelte's keyed {#each}
 * leaves the finished blocks' DOM (text selection, a "Copied" label) alone.
 */
export class BlockRenderer {
  #cache = new Map<string, string>();
  #links = "{}";

  render(src: string): Block[] {
    const tokens = md.lexer(src);
    // A reference-style link definition arriving later changes how EARLIER
    // blocks render; drop the cache when the definitions change.
    const links = JSON.stringify(tokens.links);
    if (links !== this.#links) {
      this.#cache.clear();
      this.#links = links;
    }
    const out: Block[] = [];
    const last = tokens.length - 1;
    tokens.forEach((tok: Token, i: number) => {
      if (tok.type === "space") return;
      let html = this.#cache.get(tok.raw);
      if (html === undefined) {
        html = sanitize(md.parser(Object.assign([tok], { links: tokens.links })));
        // The last block may still grow; everything before it is final.
        if (i < last) this.#cache.set(tok.raw, html);
      }
      out.push({ key: String(i), html });
    });
    return out;
  }
}
