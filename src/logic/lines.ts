// Split a byte stream's text into whole lines. Hermes writes ~50 log lines to
// stderr per start, and a pipe `data` event can end mid-line — logging chunks
// as they arrive interleaves half-lines in the output channel.

export class LineBuffer {
  private tail = "";

  /** Feed a chunk; returns every line it completed (without the newline). */
  push(chunk: string): string[] {
    const text = this.tail + chunk;
    const parts = text.split("\n");
    this.tail = parts.pop() ?? "";
    return parts.map(stripCr);
  }

  /** The unterminated remainder, if any (call on stream end). */
  flush(): string | null {
    const rest = this.tail;
    this.tail = "";
    return rest.length > 0 ? stripCr(rest) : null;
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
