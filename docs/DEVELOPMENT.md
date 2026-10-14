# Development

The README is the Marketplace page (for users). This file is for working on the code.

```bash
npm install
npm run build        # esbuild (extension host) + Vite (webview)
npm run typecheck    # tsc + svelte-check
npm run check        # biome
npm test             # unit + integration against a fake Hermes (test/fixtures/fake-agent.mjs)
npm run package      # → hermes-studio-<version>.vsix
```

`HERMES_STUDIO_REAL=1 npm test -- test/real` runs the real `hermes.exe acp` against a fake
OpenAI-compatible model server in a temporary Hermes home — full chat turns, **zero model
quota**. Windows only; never run it during a `hermes update`.

The webview in a browser: `npx vite build`, then `node test/webview/serve.mjs --port 5199`
(options in the file's header).

## Install a local build

```powershell
code --install-extension hermes-studio-<version>.vsix --force
```

Then **Developer: Reload Window**.

## The logo

`resources/brand/icon.svg` is the source. `resources/icon.png` (256 px, the extension icon)
and `resources/hermes-toast.png` (96 px, the Windows notification logo) are rendered from it
in Chromium, with Consolas for the ASCII characters.

## Publishing

A release: the version in `package.json`, a `CHANGELOG.md` entry and a git tag `vX.Y.Z`,
then a GitHub release with the `.vsix` attached. The same `.vsix` is uploaded to the
Visual Studio Marketplace by hand.
