// A tiny async mutex: lifecycle changes (start, New chat, Restart, shutdown)
// run one at a time. Without it, two quick Restarts spawn two processes and
// New chat during start creates two sessions (forked extension, lesson 21).

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // The chain must survive a rejection, or one failure blocks every later caller.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
