// Webview bundle: one fixed-name JS + CSS pair, loaded by the host through
// asWebviewUri under a nonce CSP. Verified in the slice-1 research prototype.
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  // Required: the default "/" emits url(/assets/…), which 404s inside a webview.
  base: "./",
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: resolve(root, "src/webview/lib"),
      $shared: resolve(root, "src/shared"),
    },
  },
  build: {
    outDir: resolve(root, "dist/webview"),
    emptyOutDir: true,
    // VS Code 1.106 = Electron 37 = Chromium 138 (the engine floor).
    target: "chrome138",
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: true,
    reportCompressedSize: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: resolve(root, "src/webview/main.ts"),
      output: {
        format: "es",
        codeSplitting: false,
        entryFileNames: "webview.js",
        assetFileNames: (a) =>
          a.names?.[0]?.endsWith(".css") ? "webview.css" : "assets/[name][extname]",
      },
    },
  },
});
