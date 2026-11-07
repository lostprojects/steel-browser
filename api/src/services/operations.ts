// Execution policy shared by browser work and connectors. Protocol adapters may
// retain richer result records, but must use this runner for access and stops.
import { randomUUID } from "node:crypto";

export type OperationState =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "timeout" | "expired";
export type OperationEffect = "none" | "unknown" | "applied";
export type AccessMode = "shared" | "exclusive";
export class OperationStopped extends Error {
  readonly statusCode = 408;
  constructor(
    readonly reason: string,
    readonly requestId: string,
  ) {
    super(reason);
  }
}
export interface OperationOptions {
  id?: string;
  key?: string;
  fingerprint?: string;
  resource?: object;
  access?: AccessMode;
  queueDeadline?: number;
  timeoutMs?: number;
  deadline?: number;
  timeoutError?: () => Error;
  cancelError?: () => Error;
  beforeStart?: (operation: Operation<any>) => Promise<unknown>;
  onStop?: (error: Error) => Promise<unknown> | unknown;
  // Only explicitly safe, pre-action failures can release a retry identity.
  retryBeforeAction?: boolean;
}

export class Operation<T> {
  readonly id: string;
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  state: OperationState = "queued";
  effect: OperationEffect = "none";
  deadline = Infinity;
  error?: Error;
  finishedAt?: number;
  drained = false;
  readonly promise: Promise<T>;
  private resolve!: (value: T) => void;
  private reject!: (error: unknown) => void;
  private readonly stopped: Promise<never>;
  private rejectStopped!: (error: Error) => void;
  private timer?: NodeJS.Timeout;
  private stopping?: Promise<unknown>;
  private settled = false;
  private readonly pending = new Set<Promise<unknown>>();
  readonly done: Promise<void>;
  drainedWork!: () => void;
  constructor(
    readonly options: OperationOptions,
    private now: () => number,
  ) {
    this.id = options.id ?? randomUUID();
    this.done = new Promise((resolve) => {
      this.drainedWork = resolve;
    });
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.stopped = new Promise<never>((_, reject) => {
      this.rejectStopped = reject;
    });
    void this.promise.catch(() => undefined);
    void this.stopped.catch(() => undefined);
    this.arm(options.queueDeadline ?? options.deadline ?? Infinity);
  }
  get active() {
    return !this.settled;
  }
  check() {
    if (this.active && this.now() >= this.deadline)
      this.stop(this.timeout(), this.state === "queued" ? "expired" : "timeout");
    if (this.error) throw this.error;
    if (!this.active) throw new Error("Operation has finished");
  }
  remaining(cap = Infinity) {
    this.check();
    return Math.max(1, Math.min(cap, this.deadline - this.now()));
  }
  async wait<V>(work: () => Promise<V>): Promise<V> {
    this.check();
    const pending = Promise.resolve().then(() => {
      this.check();
      return work();
    });
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => undefined);
    const value = await Promise.race([pending, this.stopped]);
    this.check();
    return value;
  }
  async drainPending() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  markActed() {
    this.check();
    this.effect = "unknown";
  }
  start() {
    this.check();
    this.state = "running";
    this.arm(
      Math.min(
        this.options.deadline ?? Infinity,
        this.options.timeoutMs === undefined ? Infinity : this.now() + this.options.timeoutMs,
      ),
    );
  }
  cancel(error = this.options.cancelError?.() ?? new OperationStopped("cancelled", this.id)) {
    this.stop(error, "cancelled");
  }
  stop(error: Error, state: OperationState = "cancelled") {
    if (!this.active) return;
    this.error = error;
    this.state = state;
    this.controller.abort(error);
    this.rejectStopped(error);
    this.stopping = Promise.resolve().then(() => this.options.onStop?.(error));
    void this.stopping.catch(() => undefined);
    this.complete(undefined, error);
  }
  async stoppedCleanup() {
    await this.stopping;
  }
  complete(value?: T, error?: unknown) {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.finishedAt = this.now();
    if (error !== undefined) {
      const inherited = (error as { effect?: unknown } | null)?.effect;
      if (inherited === "unknown" || (inherited === "applied" && this.effect === "none"))
        this.effect = inherited;
      if (error instanceof Error) this.error = error;
      this.state = this.signal.aborted ? this.state : "failed";
      this.reject(
        error instanceof Error
          ? Object.assign(error, { operationId: this.id, effect: this.effect })
          : error,
      );
    } else {
      if (this.state === "queued" || this.state === "running") this.state = "completed";
      this.resolve(value as T);
    }
  }
  private timeout() {
    return this.options.timeoutError?.() ?? new OperationStopped("timeout", this.id);
  }
  private arm(deadline: number) {
    clearTimeout(this.timer);
    this.deadline = deadline;
    if (Number.isFinite(deadline)) {
      this.timer = setTimeout(
        () => {
          if (this.active && this.deadline === deadline && this.now() >= deadline)
            this.stop(this.timeout(), this.state === "queued" ? "expired" : "timeout");
        },
        Math.max(0, deadline - this.now()),
      );
      this.timer.unref();
    }
  }
}

type Lease = { mode: AccessMode; release: () => void };
type Waiter = {
  mode: AccessMode;
  operation: Operation<any>;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
type Resource = { active: Set<Lease>; queue: Waiter[] };
export class OperationRunner {
  private readonly resources = new WeakMap<object, Resource>();
  private readonly live = new Set<Operation<any>>();
  private readonly identities = new Map<
    string,
    { fingerprint?: string; operation: Operation<any> }
  >();
  constructor(
    private now = () => Date.now(),
    private capacity = 8192,
    private ttlMs = 600_000,
  ) {}
  private resource(key: object) {
    let value = this.resources.get(key);
    if (!value) this.resources.set(key, (value = { active: new Set(), queue: [] }));
    return value;
  }
  busy(key: object) {
    const value = this.resource(key);
    return value.active.size > 0 || value.queue.length > 0;
  }
  exclusive(key: object) {
    const value = this.resource(key);
    return (
      [...value.active].some((v) => v.mode === "exclusive") ||
      value.queue.some((v) => v.mode === "exclusive")
    );
  }
  // CDP messages cannot wait for login: reject new messages while exclusive work
  // waits, and let replies release their existing shared lease.
  enter(key: object): () => void {
    const resource = this.resource(key);
    if (this.exclusive(key))
      throw Object.assign(
        new Error("Browser login or exclusive work is waiting for active work to finish"),
        { statusCode: 409 },
      );
    return this.grant(resource, "shared");
  }
  private grant(resource: Resource, mode: AccessMode) {
    const lease: Lease = {
      mode,
      release: () => {
        resource.active.delete(lease);
        this.drain(resource);
      },
    };
    resource.active.add(lease);
    return lease.release;
  }
  private drain(resource: Resource) {
    while (resource.queue.length) {
      const next = resource.queue[0];
      if (
        [...resource.active].some((v) => v.mode === "exclusive") ||
        (next.mode === "exclusive" && resource.active.size)
      )
        return;
      resource.queue.shift();
      next.operation.signal.removeEventListener("abort", next.abort);
      if (next.operation.signal.aborted) {
        next.reject(next.operation.error);
        continue;
      }
      next.resolve(this.grant(resource, next.mode));
      if (next.mode === "exclusive") return;
    }
  }
  async access(key: object, mode: AccessMode, operation: Operation<any>): Promise<() => void> {
    return this.acquire(key, mode, operation);
  }
  private acquire(key: object, mode: AccessMode, operation: Operation<any>): Promise<() => void> {
    operation.check();
    const resource = this.resource(key);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        mode,
        operation,
        resolve,
        reject,
        abort: () => {
          const index = resource.queue.indexOf(waiter);
          if (index >= 0) resource.queue.splice(index, 1);
          reject(operation.error);
          this.drain(resource);
        },
      };
      operation.signal.addEventListener("abort", waiter.abort, { once: true });
      resource.queue.push(waiter);
      this.drain(resource);
    });
  }
  lookup<T>(key: string, fingerprint?: string): Operation<T> | undefined {
    this.sweep();
    const previous = this.identities.get(key);
    if (previous && previous.fingerprint !== undefined && previous.fingerprint !== fingerprint)
      throw Object.assign(new Error("Idempotency key reused with different arguments"), {
        statusCode: 409,
      });
    return previous?.operation;
  }
  bind(key: string, fingerprint: string, operation: Operation<any>) {
    // Command recovery records also retain aliases. Avoid displacing a protected
    // identity merely to add another way to retrieve the same execution.
    if (!this.identities.has(key) && this.identities.size >= this.capacity) return;
    this.identities.set(key, { fingerprint, operation });
  }
  private reserve() {
    this.sweep();
    while (this.identities.size >= this.capacity) {
      const safe = [...this.identities].find(
        ([, entry]) =>
          entry.operation.drained &&
          entry.operation.effect === "none" &&
          !entry.operation.signal.aborted,
      );
      if (!safe)
        throw Object.assign(new Error("Too many protected or running idempotent operations"), {
          statusCode: 429,
        });
      this.identities.delete(safe[0]);
    }
  }
  start<T>(options: OperationOptions, run: (operation: Operation<T>) => Promise<T>): Operation<T> {
    if (options.key) {
      const previous = this.lookup<T>(options.key, options.fingerprint);
      if (previous) return previous;
      this.reserve();
    }
    const operation = new Operation<T>(options, this.now);
    this.live.add(operation);
    if (options.key)
      this.identities.set(options.key, { fingerprint: options.fingerprint, operation });
    void (async () => {
      let release: (() => void) | undefined;
      try {
        if (options.resource)
          release = await this.acquire(options.resource, options.access ?? "shared", operation);
        if (options.beforeStart)
          await operation.wait(() => options.beforeStart!(operation as Operation<any>));
        operation.start();
        const value = await run(operation);
        operation.check();
        operation.complete(value);
      } catch (error) {
        operation.complete(undefined, error);
        if (
          options.key &&
          options.retryBeforeAction &&
          operation.effect === "none" &&
          !operation.signal.aborted
        )
          this.identities.delete(options.key);
      } finally {
        // Keep ownership until the actual worker and its stop handler finish,
        // even if the caller has already received a deadline/cancellation error.
        try {
          await Promise.allSettled([operation.stoppedCleanup(), operation.drainPending()]);
        } finally {
          release?.();
          this.live.delete(operation);
          operation.drained = true;
          operation.drainedWork();
        }
      }
    })().catch(() => undefined);
    return operation;
  }
  run<T>(options: OperationOptions, run: (operation: Operation<T>) => Promise<T>) {
    return this.start(options, run).promise;
  }
  cancelResource(resource: object, error: Error) {
    for (const operation of this.live)
      if (operation.options.resource === resource)
        operation.cancel(Object.assign(new Error(error.message), error));
  }
  cancel(key: string, error: Error) {
    const previous = this.identities.get(key)?.operation;
    if (previous) {
      previous.cancel(error);
      return previous;
    }
    this.reserve();
    const operation = new Operation<any>({ key }, this.now);
    operation.cancel(error);
    operation.drained = true;
    operation.drainedWork();
    this.identities.set(key, { operation });
    this.sweep();
    return undefined;
  }
  private sweep() {
    for (const [key, entry] of this.identities)
      if (
        entry.operation.drained &&
        entry.operation.finishedAt !== undefined &&
        this.now() - entry.operation.finishedAt > this.ttlMs
      )
        this.identities.delete(key);
  }
}
export const operations = new OperationRunner();
