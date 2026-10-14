// The composer's "+": gather files, the editor selection, VS Code's problems,
// the git diff or an image into the next message. The host owns the list (it
// survives a webview reload); the webview only shows chips. What each item
// becomes on the wire is decided in logic/attachments.ts.

import * as path from "node:path";

import * as vscode from "vscode";

import {
  type Attachment,
  type ContextChip,
  type ContextKind,
  diffFileCount,
  gitDiffText,
  IMAGE_MAX_BASE64,
  IMAGE_MIME,
  imageDimensions,
  type Problem,
  problemsText,
  RecentImages,
  type StoredImage,
  selectionText,
} from "../logic/attachments";
import { FILE_EXCLUDE } from "./fileIndex";

/** Enough of the built-in git extension's API (vscode.git, v1). */
interface GitApi {
  repositories: { rootUri: vscode.Uri; diff(cached?: boolean): Promise<string> }[];
}

const EXCLUDE = FILE_EXCLUDE;
const MAX_FILES = 20;
const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export class AttachmentService {
  /** Only what the "+" added: the current file is not in this list. */
  private items: ComposerAttachment[] = [];
  private seq = 0;
  /** Images already sent, so their chips on the message still open. */
  private readonly sent = new RecentImages();

  constructor(
    private readonly publish: (chips: ContextChip[]) => void,
    /** Hermes advertised promptCapabilities.image. */
    private readonly imagesAllowed: () => boolean,
  ) {}

  get chips(): ContextChip[] {
    return this.items.map(({ block: _b, sourceUri: _s, ...chip }) => chip);
  }

  /** Everything for the message being sent; the list starts over. */
  take(): Attachment[] {
    const out = this.items;
    for (const a of out) {
      const img = stored(a);
      if (img) this.sent.add(a.id, img);
    }
    this.items = [];
    this.changed();
    return out;
  }

  /** A message that never went out gets its attachments back. */
  restore(list: readonly Attachment[]): void {
    const back = list.filter(isComposer);
    if (back.length === 0) return;
    const ids = new Set(this.items.map((a) => a.id));
    this.items = [...back.filter((a) => !ids.has(a.id)), ...this.items];
    this.changed();
  }

  remove(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((a) => a.id !== id);
    if (this.items.length !== before) this.changed();
  }

  /** An image chip's picture, waiting in the composer or already sent. */
  image(id: string): StoredImage | undefined {
    const waiting = this.items.find((a) => a.id === id);
    return waiting ? stored(waiting) : this.sent.get(id);
  }

  async add(kind: ContextKind): Promise<void> {
    switch (kind) {
      case "file":
        return this.addFiles();
      case "selection":
        return this.addSelection();
      case "problems":
        return this.addProblems();
      case "git":
        return this.addGitChanges();
      case "image":
        return this.pickImage();
    }
  }

  /**
   * Files dragged into the composer (with Shift: VS Code gives a webview a drop
   * only then). Files from VS Code's Explorer or an editor tab come as URIs:
   * an image goes as an image, anything else as a link Hermes reads itself.
   * Folders and other schemes are left out and said so.
   */
  async addDropped(uris: readonly string[]): Promise<void> {
    const local = new Set(["file", vscode.workspace.workspaceFolders?.[0]?.uri.scheme ?? "file"]);
    let skipped = 0;
    let added = 0;
    for (const raw of uris.slice(0, MAX_FILES)) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(raw, true);
      } catch {
        skipped++;
        continue;
      }
      if (!local.has(uri.scheme)) {
        skipped++;
        continue;
      }
      let isFile = false;
      try {
        isFile = ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) !== 0;
      } catch {
        isFile = false;
      }
      if (!isFile) {
        skipped++;
        continue;
      }
      const mime = IMAGE_EXT[path.extname(uri.fsPath).toLowerCase()];
      if (mime && this.imagesAllowed()) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        this.addImage(mime, Buffer.from(bytes).toString("base64"), path.basename(uri.fsPath));
        added++;
        continue;
      }
      const link = uri.toString();
      if (this.items.some((a) => a.block.type === "resource_link" && a.block.uri === link))
        continue;
      const rel = vscode.workspace.asRelativePath(uri, false);
      this.push({
        kind: "file",
        label: path.basename(uri.fsPath),
        detail: rel,
        block: { type: "resource_link", uri: link, name: rel },
        sourceUri: link,
      });
      added++;
    }
    if (uris.length > MAX_FILES) skipped += uris.length - MAX_FILES;
    if (skipped > 0) {
      void vscode.window.showInformationMessage(
        added > 0
          ? `Added ${added}; ${skipped} left out (folders, or not a file here). Mention a folder with @.`
          : "Nothing to add: drop files, not folders. Mention a folder with @.",
      );
    }
  }

  /** An image pasted into the composer (already base64, checked by the protocol). */
  addImage(mimeType: string, data: string, label = "Pasted image"): void {
    if (!this.imagesAllowed()) {
      void vscode.window.showInformationMessage("This Hermes does not accept images.");
      return;
    }
    if (!IMAGE_MIME.has(mimeType) || data.length > IMAGE_MAX_BASE64) {
      void vscode.window.showInformationMessage(
        "That image is too large (about 3.7 MB at most) or not PNG, JPEG, GIF or WebP.",
      );
      return;
    }
    const bytes = Buffer.from(data, "base64");
    const dims = imageDimensions(bytes);
    const kb = Math.max(1, Math.round(bytes.length / 1024));
    this.push({
      kind: "image",
      label,
      ...(dims ? { size: `${dims.width}×${dims.height}` } : {}),
      detail: `${label} · ${mimeType.replace("image/", "").toUpperCase()} · ${kb} KB · click to view`,
      block: { type: "image", mimeType, data },
    });
  }

  private push(a: Omit<ComposerAttachment, "id">): void {
    this.items.push({ ...a, id: `ctx~${++this.seq}` });
    this.changed();
  }

  private changed(): void {
    this.publish(this.chips);
  }

  /**
   * An "@" pick: this workspace file, by the relative path the "@" list gave
   * (multi-root: "<folder>/<path>"). Only a file inside an open folder — a
   * folder stays text in the message (Hermes can list it).
   */
  async addFileByPath(rel: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const parts = rel.split("/").filter(Boolean);
    const odd = (p: string) => p === "." || p === ".." || p.includes("\\") || p.includes(":");
    if (folders.length === 0 || parts.length === 0 || parts.some(odd)) return;
    let base = folders[0];
    let segs = parts;
    if (folders.length > 1) {
      const named = folders.find((f) => f.name === parts[0]);
      if (named) {
        base = named;
        segs = parts.slice(1);
      }
    }
    if (!base || segs.length === 0) return;
    const uri = vscode.Uri.joinPath(base.uri, ...segs);
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (!(st.type & vscode.FileType.File)) return;
    } catch {
      return;
    }
    const link = uri.toString();
    if (this.items.some((a) => a.block.type === "resource_link" && a.block.uri === link)) return;
    this.push({
      kind: "file",
      label: path.basename(uri.fsPath),
      detail: rel,
      block: { type: "resource_link", uri: link, name: rel },
      sourceUri: link,
    });
  }

  private async addFiles(): Promise<void> {
    const found = await vscode.workspace.findFiles("**/*", EXCLUDE, 5000);
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    type Item = vscode.QuickPickItem & { uri: vscode.Uri };
    const items: Item[] = found
      .map((uri) => {
        const rel = vscode.workspace.asRelativePath(uri, false);
        return {
          label: path.basename(uri.fsPath),
          description: path.dirname(rel) === "." ? "" : path.dirname(rel),
          uri,
          picked: false,
        };
      })
      .sort((a, b) => {
        // The file you are looking at first, then by path.
        const aa = a.uri.toString() === active ? 0 : 1;
        const bb = b.uri.toString() === active ? 0 : 1;
        return (
          aa - bb || `${a.description}/${a.label}`.localeCompare(`${b.description}/${b.label}`)
        );
      });
    const picks = await vscode.window.showQuickPick(items, {
      title: "Add files to the message",
      placeHolder: "Type to search · Space to pick several · Enter to add",
      canPickMany: true,
      matchOnDescription: true,
    });
    if (!picks?.length) return;
    const have = new Set(
      this.items.flatMap((a) => (a.block.type === "resource_link" ? [a.block.uri] : [])),
    );
    for (const p of picks.slice(0, MAX_FILES)) {
      const uri = p.uri.toString();
      if (have.has(uri)) continue;
      const rel = vscode.workspace.asRelativePath(p.uri, false);
      // Hermes reads the file itself (up to 512 KB) when it gets the link.
      this.push({
        kind: "file",
        label: p.label,
        detail: rel,
        block: { type: "resource_link", uri, name: rel },
        sourceUri: uri,
      });
    }
    if (picks.length > MAX_FILES) {
      void vscode.window.showInformationMessage(`Added the first ${MAX_FILES} files.`);
    }
  }

  private addSelection(): void {
    const ed = vscode.window.activeTextEditor;
    const sel = ed?.selections.filter((s) => !s.isEmpty) ?? [];
    if (!ed || sel.length === 0) {
      void vscode.window.showInformationMessage("Select some code in the editor first.");
      return;
    }
    const doc = ed.document;
    const rel =
      doc.uri.scheme === "file" ? vscode.workspace.asRelativePath(doc.uri, false) : doc.fileName;
    for (const s of sel) {
      // A selection ending at column 0 of a line does not include that line.
      const endLine =
        s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1;
      const startLine = s.start.line + 1;
      const text = doc.getText(s);
      const range = startLine === endLine ? `${startLine}` : `${startLine}–${endLine}`;
      this.push({
        kind: "selection",
        label: `${path.basename(rel)} ${range}`,
        detail: `${rel}, ${startLine === endLine ? "line" : "lines"} ${range}`,
        block: { type: "text", text: selectionText(rel, startLine, endLine, doc.languageId, text) },
        sourceUri: doc.uri.toString(),
      });
    }
  }

  private addProblems(): void {
    const problems: Problem[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        if (
          d.severity !== vscode.DiagnosticSeverity.Error &&
          d.severity !== vscode.DiagnosticSeverity.Warning
        )
          continue;
        problems.push({
          path: vscode.workspace.asRelativePath(uri, false),
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
          message: d.message,
          ...(d.source ? { source: d.source } : {}),
        });
      }
    }
    if (problems.length === 0) {
      void vscode.window.showInformationMessage("VS Code reports no errors or warnings right now.");
      return;
    }
    this.items = this.items.filter((a) => a.kind !== "problems"); // one, always current
    const errors = problems.filter((p) => p.severity === "error").length;
    this.push({
      kind: "problems",
      label: `Problems (${problems.length})`,
      detail: `${errors} errors, ${problems.length - errors} warnings`,
      block: { type: "text", text: problemsText(problems) },
    });
  }

  private async addGitChanges(): Promise<void> {
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>("vscode.git");
    let api: GitApi | undefined;
    try {
      api = (ext?.isActive ? ext.exports : await ext?.activate())?.getAPI(1);
    } catch {
      api = undefined;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const repo =
      api?.repositories.find(
        (r) => folder && path.relative(r.rootUri.fsPath, folder).split(path.sep)[0] !== "..",
      ) ?? api?.repositories[0];
    if (!repo) {
      void vscode.window.showInformationMessage("No git repository here.");
      return;
    }
    const diff = [await repo.diff(true), await repo.diff(false)].filter((d) => d.trim()).join("\n");
    if (!diff.trim()) {
      void vscode.window.showInformationMessage("No uncommitted changes.");
      return;
    }
    this.items = this.items.filter((a) => a.kind !== "git"); // one, always current
    const n = diffFileCount(diff);
    this.push({
      kind: "git",
      label: `Git changes (${n} file${n === 1 ? "" : "s"})`,
      detail: "staged and unstaged",
      block: { type: "text", text: gitDiffText(diff) },
    });
  }

  private async pickImage(): Promise<void> {
    if (!this.imagesAllowed()) {
      void vscode.window.showInformationMessage("This Hermes does not accept images.");
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      title: "Add an image to the message",
      canSelectMany: false,
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
    });
    const uri = picked?.[0];
    if (!uri) return;
    const mime = IMAGE_EXT[path.extname(uri.fsPath).toLowerCase()];
    if (!mime) return;
    const bytes = await vscode.workspace.fs.readFile(uri);
    this.addImage(mime, Buffer.from(bytes).toString("base64"), path.basename(uri.fsPath));
  }
}

/** An attachment the "+" made (not the current file, which rides along). */
type ComposerAttachment = Attachment & { kind: ContextKind };

function isComposer(a: Attachment): a is ComposerAttachment {
  return a.kind !== "editor";
}

function stored(a: Attachment): StoredImage | undefined {
  if (a.block.type !== "image") return undefined;
  return {
    label: a.label,
    ...(a.size ? { size: a.size } : {}),
    mimeType: a.block.mimeType,
    data: a.block.data,
  };
}
