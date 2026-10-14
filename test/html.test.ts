import { describe, expect, it } from "vitest";

import { buildCsp, buildHtml } from "../src/logic/html";

describe("webview HTML", () => {
  const src = "https://file+.vscode-resource.vscode-cdn.net";

  it("uses a nonce-only script-src and no nonce in style-src", () => {
    const csp = buildCsp(src, "abc123==");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc123=='");
    // A nonce in style-src makes the browser ignore 'unsafe-inline' (measured).
    expect(csp).toMatch(/style-src [^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/style-src [^;]*nonce/);
    expect(csp).not.toContain("unsafe-eval");
  });

  // No https: in img-src — a markdown image would otherwise send data out.
  it("allows no remote images and no network access", () => {
    const csp = buildCsp(src, "n");
    const imgSources = /img-src ([^;]*)/.exec(csp)?.[1]?.split(/\s+/) ?? [];
    // Only the webview's own origin (itself an https URL) and data: — never a
    // bare `https:` / `*` source that would admit any remote host.
    expect(imgSources).toEqual([src, "data:"]);
    expect(csp).not.toContain("connect-src");
  });

  it("puts the nonce on the module script and escapes attribute values", () => {
    const html = buildHtml({
      cspSource: src,
      nonce: "n0nce",
      scriptUri: `${src}/webview.js?a="x"`,
      styleUri: `${src}/webview.css`,
    });
    expect(html).toContain('<script type="module" nonce="n0nce"');
    expect(html).toContain("webview.js?a=&quot;x&quot;");
    expect(html).not.toContain('a="x"');
  });
});
