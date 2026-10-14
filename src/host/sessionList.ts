// The Sessions view's data: pages from Hermes's session/list, accumulated, with
// loading and error states. No `vscode` import (tested directly).
//
// Every change is pushed whole (`sessions` message). A newer request makes an
// older one's result moot — the user reopened the view, or a turn ended and
// the list was refreshed — so only the latest request may publish.

import { errorText } from "../logic/errors";
import type { SessionList } from "../shared/protocol";
import type { SessionPage } from "./chatController";

export class SessionListService {
  private list: SessionList = { items: [], loading: false };
  private seq = 0;

  constructor(
    private readonly fetchPage: (cursor?: string) => Promise<SessionPage>,
    private readonly publish: (list: SessionList) => void,
  ) {}

  get current(): SessionList {
    return this.list;
  }

  /** The first page again (replacing what is shown), or the page after `cursor`. */
  async request(cursor?: string): Promise<void> {
    const seq = ++this.seq;
    this.set({ ...this.list, loading: true, error: undefined });
    try {
      const page = await this.fetchPage(cursor);
      if (seq !== this.seq) return;
      const items = cursor ? mergePages(this.list.items, page.items) : page.items;
      this.set(
        page.nextCursor
          ? { items, nextCursor: page.nextCursor, loading: false }
          : { items, loading: false },
      );
    } catch (e) {
      if (seq !== this.seq) return;
      this.set({ ...this.list, loading: false, error: errorText(e) });
    }
  }

  private set(list: SessionList): void {
    // No `undefined` values: postMessage is JSON and would drop the key anyway.
    const clean: SessionList = { items: list.items, loading: list.loading };
    if (list.nextCursor) clean.nextCursor = list.nextCursor;
    if (list.error) clean.error = list.error;
    this.list = clean;
    this.publish(clean);
  }
}

/** Append a page, dropping ids already shown (the list can shift between pages
 *  when a session is updated meanwhile). */
function mergePages(shown: SessionList["items"], page: SessionList["items"]): SessionList["items"] {
  const seen = new Set(shown.map((s) => s.id));
  return [...shown, ...page.filter((s) => !seen.has(s.id))];
}
