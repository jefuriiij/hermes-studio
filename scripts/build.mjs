// One entry point for both bundles: `node scripts/build.mjs [--watch] [--production]`
//   host    → esbuild → dist/extension.js (CommonJS, Node 22, `vscode` external)
//   webview → Vite    → dist/webview/webview.{js,css}
import * as esbuild from "esbuild";
import { build as viteBuild } from "vite";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** @type {import('esbuild').BuildOptions} */
const host = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  // VS Code 1.106 (the engine floor) runs Electron 37 → Node 22.
  target: "node22",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(host);
  await ctx.watch();
  await viteBuild({ mode: "development", build: { watch: {}, minify: false } });
} else {
  await Promise.all([
    esbuild.build(host),
    viteBuild({ mode: production ? "production" : "development" }),
  ]);
}
