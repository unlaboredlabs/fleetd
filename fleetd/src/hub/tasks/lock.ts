// The tasks area's async lock and its start notifications (the Rust area's `tokio::sync::Mutex` and `Notify`).

/** One holder at a time; `acquire` resolves with the release, in the order callers asked. */
export class Lock {
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = this.tail;
    this.tail = before.then(() => held);
    let released = false;
    return before.then(() => () => {
      if (released) return;
      released = true;
      release();
    });
  }

  /** `fn` with the lock held. */
  async with<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Wakes everyone waiting at the time of a `notifyWaiters`, as tokio's `Notify::notify_waiters`. */
export class Notify {
  private waiters: (() => void)[] = [];

  /** A promise for the next `notifyWaiters`; take it before checking, so a notify between the two isn't missed. */
  notified(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  notifyWaiters(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
  }
}
