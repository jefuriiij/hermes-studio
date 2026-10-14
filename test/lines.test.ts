import { describe, expect, it } from "vitest";

import { LineBuffer } from "../src/logic/lines";

describe("LineBuffer", () => {
  it("holds a partial line until its newline arrives", () => {
    const b = new LineBuffer();
    expect(b.push("2026-09-26 [INFO] start")).toEqual([]);
    expect(b.push("ing\n2026-09-26 [INFO] ready\npartial")).toEqual([
      "2026-09-26 [INFO] starting",
      "2026-09-26 [INFO] ready",
    ]);
    expect(b.flush()).toBe("partial");
    expect(b.flush()).toBeNull();
  });

  // Windows text-mode output ends lines with CRLF.
  it("strips a trailing CR, including one split from its LF", () => {
    const b = new LineBuffer();
    expect(b.push("one\r")).toEqual([]);
    expect(b.push("\ntwo\r\n")).toEqual(["one", "two"]);
  });

  it("keeps empty lines", () => {
    expect(new LineBuffer().push("a\n\nb\n")).toEqual(["a", "", "b"]);
  });
});
