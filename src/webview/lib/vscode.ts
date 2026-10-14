// The webview's only door to the extension host.
//
// acquireVsCodeApi() may be called ONCE per webview document — a second call
// throws "An instance of the VS Code API has already been acquired". This
// module is therefore the only caller; everything else imports post/getState.

import type { HostToWebview, WebviewToHost } from "$shared/protocol";

/** UI-only state VS Code keeps for us across hide/show and window reloads.
 *  The transcript is NOT here: the host owns it and re-sends it on `ready`. */
export interface PersistedState {
  draft: string;
  /** The tab on screen (Chat or a Hermes panel); the store checks the name. */
  tab?: string;
}

const api = acquireVsCodeApi<PersistedState>();

export function post(msg: WebviewToHost): void {
  api.postMessage(msg);
}

export function getState(): PersistedState | undefined {
  // Whatever an older build stored comes back verbatim; never trust its shape.
  const s: unknown = api.getState();
  if (typeof s !== "object" || s === null) return undefined;
  const { draft, tab } = s as { draft?: unknown; tab?: unknown };
  return {
    draft: typeof draft === "string" ? draft : "",
    ...(typeof tab === "string" ? { tab } : {}),
  };
}

export function setState(s: PersistedState): void {
  api.setState(s);
}

/** Subscribe to host messages. Call before mounting so an early `init` is not
 *  missed; returns an unsubscribe function. */
export function onHostMessage(handler: (msg: HostToWebview) => void): () => void {
  const listener = (e: MessageEvent<unknown>) => {
    const d = e.data;
    if (typeof d === "object" && d !== null && typeof (d as { type?: unknown }).type === "string") {
      handler(d as HostToWebview);
    }
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
