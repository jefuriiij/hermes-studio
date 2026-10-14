// The workspace's paths for the composer's "@" list. Read with findFiles (the
// same excludes as the "+" menu's file picker) and kept for a short while, so
// typing "@log" → "@logi" does not walk the disk on every key. Ranking lives
// in logic/fuzzy.ts.

import * as vscode from "vscode";

import { foldersOf, type PathHit, rankPaths } from "../logic/fuzzy";

export const FILE_EXCLUDE =
  "**/{node_modules,.git,dist,out,build,.next,.nuxt,.venv,venv,__pycache__,.turbo,coverage}/**";
/** Enough for a big repo; a monorepo past this ranks within the first part. */
const MAX_FILES = 20_000;
/** Files appear and disappear as Hermes works: read again after this long. */
const FRESH_MS = 20_000;

export class FileIndex {
  private hits?: PathHit[];
  private at = 0;
  private reading?: Promise<PathHit[]>;

  async search(query: string, limit = 20): Promise<PathHit[]> {
    return rankPaths(await this.paths(), query, limit);
  }

  private async paths(): Promise<PathHit[]> {
    if (this.hits && Date.now() - this.at < FRESH_MS) return this.hits;
    this.reading ??= this.read().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  private async read(): Promise<PathHit[]> {
    const uris = await vscode.workspace.findFiles("**/*", FILE_EXCLUDE, MAX_FILES);
    const files = uris
      .filter((u) => u.scheme === "file")
      .map((u) => vscode.workspace.asRelativePath(u, false).replace(/\\/g, "/"));
    const hits: PathHit[] = [
      ...files.map((path) => ({ path, kind: "file" as const })),
      ...foldersOf(files).map((path) => ({ path, kind: "folder" as const })),
    ];
    this.hits = hits;
    this.at = Date.now();
    return hits;
  }
}
