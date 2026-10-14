// The file you are in goes along with every message, like in Claude Code: the
// composer shows it as a chip, × leaves it out until you move to another
// file. Only the path and line (or the selected lines) are sent — never the
// whole file; Hermes can read it if it matters. Text lives in
// logic/attachments.ts (editorContextText).

import * as path from "node:path";

import * as vscode from "vscode";

import { type Attachment, editorContextText } from "../logic/attachments";
import type { EditorChip } from "../shared/protocol";

interface Snapshot {
  uri: string;
  rel: string;
  line: number;
  /** `range`: the selection itself, for when its editor is out of sight. */
  selection?: { startLine: number; endLine: number; range: vscode.Range };
}

export class EditorContextService implements vscode.Disposable {
  private current?: Snapshot;
  /** The file whose chip was ×-ed; moving to another file clears it. */
  private excludedUri?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly subs: vscode.Disposable[] = [];
  private lastSent = "";

  constructor(private readonly publish: (chip: EditorChip | null) => void) {
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(0)),
      // Selections change on every keystroke and cursor move: settle first.
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.schedule(150);
      }),
      // Closing the file's tab ends it (see `read`).
      vscode.window.tabGroups.onDidChangeTabs(() => this.schedule(0)),
    );
    this.read();
  }

  get chip(): EditorChip | null {
    const c = this.current;
    if (!c) return null;
    const name = path.basename(c.rel);
    const range = c.selection ? rangeText(c.selection.startLine, c.selection.endLine) : "";
    return {
      label: range ? `${name} ${range}` : name,
      detail: c.selection
        ? `Hermes sees ${c.rel} and your selection (${range.includes("–") ? "lines" : "line"} ${range}).`
        : `Hermes sees that you are in ${c.rel}, line ${c.line}.`,
      excluded: this.excludedUri === c.uri,
    };
  }

  toggle(): void {
    const c = this.current;
    if (!c) return;
    this.excludedUri = this.excludedUri === c.uri ? undefined : c.uri;
    this.changed();
  }

  /**
   * What goes along with a message being sent, read fresh from the editor.
   * Nothing when excluded, or when the "+" already attached that file.
   */
  forSend(attached: readonly Attachment[]): Attachment | undefined {
    this.read();
    const c = this.current;
    if (!c || this.excludedUri === c.uri) return undefined;
    if (attached.some((a) => a.sourceUri === c.uri)) return undefined;
    const chip = this.chip;
    // The selected text comes from that file's own editor, even when an
    // output panel (or the chat) has the focus now. With the chat in an
    // editor tab over the file, the file is out of sight: its document and
    // the selection as it was.
    const ed = [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors].find(
      (e) => e?.document.uri.toString() === c.uri,
    );
    const doc =
      ed?.document ?? vscode.workspace.textDocuments.find((d) => d.uri.toString() === c.uri);
    const range = ed ? ed.selection : c.selection?.range;
    const selection =
      c.selection && doc && range && !range.isEmpty
        ? {
            startLine: c.selection.startLine,
            endLine: c.selection.endLine,
            languageId: doc.languageId,
            text: doc.getText(range),
          }
        : undefined;
    return {
      id: `editor~${Date.now()}`,
      kind: "editor",
      label: chip?.label ?? path.basename(c.rel),
      sourceUri: c.uri,
      block: { type: "text", text: editorContextText(c.rel, c.line, selection) },
    };
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const s of this.subs) s.dispose();
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.read(), ms);
  }

  /** Only real files: an output panel, a diff view or an untitled buffer
   *  keeps the last file (Claude Code does the same). No text editor in
   *  front (the chat's editor tab, an image, the settings): the last file
   *  while its tab is still open, then none. */
  private read(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      if (this.current && !tabOpen(this.current.uri)) this.set(undefined);
      return;
    }
    const doc = ed.document;
    if (doc.uri.scheme !== "file") return;
    const s = ed.selection;
    // A selection ending at column 0 of a line does not include that line.
    const endLine =
      s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1;
    this.set({
      uri: doc.uri.toString(),
      rel: vscode.workspace.asRelativePath(doc.uri, false),
      line: s.active.line + 1,
      ...(s.isEmpty ? {} : { selection: { startLine: s.start.line + 1, endLine, range: s } }),
    });
  }

  private set(next: Snapshot | undefined): void {
    if (next?.uri !== this.current?.uri) this.excludedUri = undefined;
    this.current = next;
    this.changed();
  }

  private changed(): void {
    const chip = this.chip;
    const key = JSON.stringify(chip);
    if (key === this.lastSent) return; // the cursor moved inside the same line range
    this.lastSent = key;
    this.publish(chip);
  }

  /** Re-send what the chip shows (a webview that reloaded). */
  republish(): void {
    this.lastSent = "";
    this.changed();
  }
}

/** The file is open in a tab somewhere (as a file, or a side of a diff). */
function tabOpen(uri: string): boolean {
  return vscode.window.tabGroups.all.some((g) =>
    g.tabs.some((t) => {
      const i = t.input;
      if (i instanceof vscode.TabInputText) return i.uri.toString() === uri;
      if (i instanceof vscode.TabInputTextDiff) {
        return i.modified.toString() === uri || i.original.toString() === uri;
      }
      return false;
    }),
  );
}

function rangeText(start: number, end: number): string {
  return start === end ? `${start}` : `${start}–${end}`;
}
