// Turning errors from Hermes into something the header can act on.

/** A JSON-RPC error as the ACP SDK surfaces it (RequestError). */
interface RpcErrorLike {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

/**
 * The most specific human-readable text in an error. Hermes wraps agent
 * failures as -32603 "Internal error" with the real reason in
 * `data.details` — the generic message alone tells the user nothing.
 */
export function errorText(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const r = e as RpcErrorLike;
    const data = r.data;
    if (typeof data === "object" && data !== null) {
      const details = (data as { details?: unknown }).details;
      if (typeof details === "string" && details.trim()) return details.trim();
    }
    if (typeof r.message === "string" && r.message.trim()) return r.message.trim();
  }
  if (typeof e === "string" && e.trim()) return e.trim();
  return String(e);
}

/**
 * Hermes with no model provider configured fails `session/new` with
 * "No LLM provider configured. Run `hermes model` to select a provider, or run
 * `hermes setup` for first-time configuration." (agent_init.py). That is not a
 * crash to restart from; it needs `hermes model`, so the header offers setup.
 */
export function isSetupNeeded(e: unknown): boolean {
  const t = errorText(e).toLowerCase();
  return (
    t.includes("no llm provider configured") ||
    (t.includes("hermes model") && t.includes("provider")) ||
    t.includes("hermes setup")
  );
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${Math.round(ms / 1000)} s`);
    this.name = "TimeoutError";
  }
}

/** Race a promise against a timer; the timer never keeps Node alive. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

/** Resolve after `ms` (or never reject); used as a race partner. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}
