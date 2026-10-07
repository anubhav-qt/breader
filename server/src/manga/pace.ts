/*
 * Keeping to MangaDex's limits from one address however many readers ask at once: calls wait their
 * turn in order, and a turn too far off is refused instead, so the queue can't grow without end.
 */

export class Busy extends Error {
  constructor() {
    super('MangaDex is busy');
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** At most `count` calls starting in any `per` ms. */
export class Pace {
  private starts: number[] = [];
  private until = 0;
  private readonly count: number;
  private readonly per: number;
  private readonly maxWait: number;
  constructor(count: number, per: number, maxWait: number) {
    this.count = count;
    this.per = per;
    this.maxWait = maxWait;
  }

  /** Waits for a turn, or throws Busy when it's further off than maxWait. */
  async take(): Promise<void> {
    const now = Date.now();
    // Starts older than the window can't hold up one from now on.
    while (this.starts.length && this.starts[0] <= now - this.per) this.starts.shift();
    const n = this.starts.length;
    const at = Math.max(now, this.until, n >= this.count ? this.starts[n - this.count] + this.per : now);
    if (at - now > this.maxWait) throw new Busy();
    this.starts.push(at);
    if (at > now) await sleep(at - now);
  }

  /** MangaDex said to stop until then (429): nothing starts before it. */
  hold(until: number) {
    this.until = Math.max(this.until, until);
  }
}

/** At most `max` at once; the rest wait, up to maxWait. */
export class Gate {
  private running = 0;
  private waiting: Array<() => void> = [];
  private readonly max: number;
  private readonly maxWait: number;
  constructor(max: number, maxWait: number) {
    this.max = max;
    this.maxWait = maxWait;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      await new Promise<void>((go, fail) => {
        const t = setTimeout(() => {
          this.waiting = this.waiting.filter((w) => w !== turn);
          fail(new Busy());
        }, this.maxWait);
        const turn = () => {
          clearTimeout(t);
          go();
        };
        this.waiting.push(turn);
      });
    } else this.running++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      // The slot passes straight to the next in line.
      if (next) next();
      else this.running--;
    }
  }
}
