// An async lock, for what the Rust code holds a tokio Mutex across awaits for: one holder at a time, in arrival order.

export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private held = false;
  private waiting = 0;

  /** Waits for the lock; call the returned function to let it go. */
  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const before = this.tail;
    this.tail = before.then(() => next);
    this.waiting++;
    await before;
    this.waiting--;
    this.held = true;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.held = false;
      release();
    };
  }

  /** The lock if no one holds or waits for it, else undefined (tokio's `try_lock`). */
  tryLock(): (() => void) | undefined {
    if (this.held || this.waiting > 0) return undefined;
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    this.tail = this.tail.then(() => next);
    this.held = true;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.held = false;
      release();
    };
  }

  /** Runs `fn` holding the lock. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.lock();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** One lock per key, made on first use (the Rust `RepoLocks`). */
export class Locks {
  private readonly locks = new Map<string, Mutex>();

  of(key: string): Mutex {
    let m = this.locks.get(key);
    if (!m) {
      m = new Mutex();
      this.locks.set(key, m);
    }
    return m;
  }
}
