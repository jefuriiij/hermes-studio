// Webview entry. Order matters:
//   1. listen — the host answers `ready` with `init`, and a message posted
//      before a listener exists is simply lost;
//   2. mount the app;
//   3. announce `ready`. The host then discards any ops it queued and sends one
//      `init` snapshot (plan §8), so a reloaded webview never shows text twice.

import { mount } from "svelte";
import App from "./App.svelte";
import { chat } from "$lib/chat.svelte";
import { onHostMessage, post } from "$lib/vscode";
import "./app.css";

onHostMessage((msg) => chat.apply(msg));

const target = document.getElementById("app");
if (!target) throw new Error("Hermes Studio: #app element missing from the webview HTML");
mount(App, { target });

post({ type: "ready" });
