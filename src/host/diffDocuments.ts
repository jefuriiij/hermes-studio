// "Open diff" for approval cards and edit steps: VS Code's side-by-side diff
// editor over two read-only in-memory documents. (Until slice 4 this file was
// the modal permission dialog; approvals are now cards in the chat.)

import * as vscode from "vscode";

export const DIFF_SCHEME = "hermes-studio-diff";

/** Read-only in-memory documents for the diff editor. */
export class DiffDocuments implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private seq = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? "";
  }

  /** Store a text; the returned URI keeps the file name so VS Code picks the language. */
  put(name: string, side: "before" | "after", text: string): vscode.Uri {
    const safeName = name.replace(/[^\w.-]+/g, "_") || "file";
    const path = `/${++this.seq}/${side}/${safeName}`;
    this.docs.set(path, text);
    // Keep memory bounded: only recently opened diffs are still on screen.
    while (this.docs.size > 40) {
      const first = this.docs.keys().next().value;
      if (first === undefined) break;
      this.docs.delete(first);
    }
    return vscode.Uri.from({ scheme: DIFF_SCHEME, path });
  }
}

export async function openDiff(
  docs: DiffDocuments,
  diff: { path: string; oldText: string; newText: string },
  title?: string,
): Promise<void> {
  const name = diff.path.split(/[\\/]/).pop() ?? "file";
  const left = docs.put(name, "before", diff.oldText);
  const right = docs.put(name, "after", diff.newText);
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    title ?? `Hermes: ${name} (proposed)`,
    {
      preview: true,
    },
  );
}
