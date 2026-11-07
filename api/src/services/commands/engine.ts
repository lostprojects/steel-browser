import { OperationRunner } from "../operations.js";
import type { Protocol } from "devtools-protocol";
import type { BrowserControl } from "../browser-control.js";
import {
  commandHash,
  isControl,
  isMutating,
  requestSchema,
  scopedKey,
  type Command,
  type CommandRequest,
} from "./commands.js";
import { describeDialog, openDialog, type Dialog, type DialogHandler } from "./dialogs.js";
import { statusFor, type RequestErrorCode } from "./errors.js";
import {
  crashedTab,
  dialogNote,
  execute,
  observe,
  openDialogOn,
  pageInfo,
  watchBlocking,
  type Context,
} from "./handlers/index.js";
import { isFinal, type ErrorInfo, type Execution, type ExecutionState } from "./records.js";
import { combine, errorInfo, within } from "./results.js";
import {
  ActiveSession,
  Counters,
  DEFAULT_ENGINE_LIMITS,
  KEPT_DOWNLOADS,
  KEPT_EVENTS,
  STEP_MS,
  type EngineHost,
  type EngineLimits,
  type Job,
} from "./session.js";
import { handleGroup } from "./targets.js";
import { OpenDialogs, type Tab } from "./tabs.js";

export type { EngineHost, EngineLimits } from "./session.js";

const EVENTS_PER_RESPONSE = 100;

const BLOCKED_GRACE_MS = 200;

const BLOCKED = Symbol("blocked");

const RECOVERS = new Set(["navigate", "reload"]);

const MAX_IDEMPOTENCY_KEY = 255;

export interface EngineOptions {
  limits?: Partial<EngineLimits>;
  now?: () => number;
  runner?: OperationRunner;
  resource?: object;
}

export interface EngineRequest {
  sessionId: string;
  idempotencyKey?: string;
  body: unknown;
  // Trusted application callback; never accepted from the JSON command body.
  authorize?: () => Promise<void> | void;
}

export interface EngineResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export class CommandEngine {
  private active: ActiveSession | null = null;
  private readonly counters = new Counters();
  private readonly openDialogs = new OpenDialogs();
  private browser: BrowserControl | null = null;
  private ready = false;
  private readonly limits: EngineLimits;
  private readonly now: () => number;
  readonly runner: OperationRunner;
  readonly resource: object;
  private readyListeners = new Set<() => void>();

  constructor(
    private readonly host: EngineHost,
    options: EngineOptions = {},
  ) {
    this.limits = { ...DEFAULT_ENGINE_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.runner = options.runner ?? new OperationRunner(this.now);
    this.resource = options.resource ?? this;
  }

  prepare(sessionId: string) {
    if (this.active) {
      this.end(this.active);
    }
    const active: ActiveSession = new ActiveSession(
      sessionId,
      this.limits,
      this.now,
      {
        dialogOpened: (tab, event) => this.dialogOpened(active, tab, event),
        dialogClosed: (tab, event) => this.dialogClosed(active, tab, event),
        downloadStarted: (tab, event) => {
          active.downloads.set(event.guid, {
            file: this.host.downloadsByGuid ? event.guid : event.suggestedFilename,
            name: event.suggestedFilename,
            url: event.url,
            startedAt: Date.now(),
            taken: false,
          });
          for (const guid of active.downloads.keys()) {
            if (active.downloads.size <= KEPT_DOWNLOADS) {
              break;
            }
            active.downloads.delete(guid);
          }
          this.record(active, "download", tab.id, {
            file: event.suggestedFilename,
            url: event.url,
            state: "started",
          });
        },
        downloadProgress: (tab, event) => {
          const download = active.downloads.get(event.guid);
          if (event.state === "inProgress" || !download || download.state) {
            return;
          }
          download.state = event.state;
          download.bytes = event.receivedBytes;
          this.record(active, "download", tab.id, {
            file: download.file,
            url: download.url,
            state: event.state,
            bytes: event.receivedBytes,
          });
        },
        navigated: (tab, url, sameDocument) =>
          this.record(active, "navigation", tab.id, {
            url,
            ...(sameDocument ? { sameDocument } : {}),
          }),
        opened: (tab, opener) =>
          this.record(active, "tab_opened", tab.id, opener ? { opener: opener.id } : {}),
        closed: (tab) => {
          const dialog = openDialogOn(active, tab.id);
          if (dialog) {
            this.finishDialog(active, dialog, false, undefined, dialog.by ?? "closed");
          }
          this.record(active, "tab_closed", tab.id, {});
        },
      },
      this.counters,
      this.openDialogs,
    );
    this.active = active;
    this.ready = false;
  }

  browserLaunched(browser: BrowserControl) {
    if (this.browser === browser) {
      return;
    }
    this.browser = browser;
    this.ready = false;
    this.openDialogs.attach(browser);
    this.active?.tabs.detach();
  }

  browserReady() {
    const browser = this.host.browser();
    if (!browser) {
      return;
    }
    this.browser = browser;
    this.ready = true;
    this.openDialogs.attach(browser);
    const active = this.active;
    if (active) {
      active.browser = browser;
      active.tabs.attach(browser);
      for (const resolve of this.readyListeners) resolve();
      this.readyListeners.clear();
    }
  }

  browserClosed(browser: BrowserControl) {
    if (this.browser !== browser) {
      return;
    }
    this.browser = null;
    this.ready = false;
    this.openDialogs.detach();
    const active = this.active;
    if (active?.browser === browser) {
      this.restart(active);
    }
    active?.tabs.detach();
  }

  pageChanged() {
    this.active?.records.bump();
  }

  busy(): boolean {
    const active = this.active;
    return !!active && [...active.jobs.values()].some((job) => job.operation?.active);
  }

  sessionEnded() {
    if (this.active) {
      this.end(this.active);
      this.active = null;
    }
  }

  // Session boundaries retain early dialog observation while Chrome is alive.
  // Dispose when the engine itself is replaced or its browser is shutting down.
  dispose() {
    this.sessionEnded();
    this.openDialogs.detach();
    this.browser = null;
    this.ready = false;
  }

  async handle(request: EngineRequest): Promise<EngineResponse> {
    try {
      return await this.dispatch(request);
    } catch (error) {
      return ok({ error: errorInfo(error) });
    }
  }

  private async dispatch(request: EngineRequest): Promise<EngineResponse> {
    const deadline = this.now() + this.limits.responseDeadlineMs;
    const active = this.active;
    if (!active || active.id !== request.sessionId) {
      return ended(request.sessionId);
    }
    if (this.host.released(active.id)) {
      this.sessionEnded();
      return ended(request.sessionId);
    }
    const key = request.idempotencyKey;
    if (key !== undefined && (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY)) {
      return failure(
        "invalid_request",
        `Idempotency-Key must be 1 to ${MAX_IDEMPOTENCY_KEY} characters.`,
      );
    }
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return failure(
        "invalid_request",
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
          .join("; "),
      );
    }
    const body = parsed.data;
    active.records.sweep();
    if (body.commands.some(isControl)) {
      if (body.commands.length > 1) {
        return failure("invalid_request", "Send a control command on its own.");
      }
      return this.control(active, body.commands[0], deadline, body.eventsAfter);
    }
    return this.submit(active, key, body, deadline, request.authorize);
  }

  private retry(active: ActiveSession, key: string, hash: string) {
    // Check conflicts through the protocol record so callers keep its error code.
    const record = active.records.byKey(key);
    if (record && record.hash !== hash) return record;
    const operation = this.runner.lookup(key, hash);
    return operation ? active.records.get(operation.id) : record;
  }

  private async submit(
    active: ActiveSession,
    idempotencyKey: string | undefined,
    body: CommandRequest,
    deadline: number,
    authorize?: EngineRequest["authorize"],
  ): Promise<EngineResponse> {
    const records = active.records;
    const hash = commandHash(body.commands);
    const headerKey = idempotencyKey ? scopedKey(active.id, "key", idempotencyKey) : null;
    const afterKey = body.after ? scopedKey(active.id, "after", body.after, hash) : null;
    const live = (execution: Execution | undefined) =>
      execution && execution.state !== "expired" ? execution : undefined;
    const existing =
      live(headerKey ? this.retry(active, headerKey, hash) : undefined) ??
      live(afterKey ? this.retry(active, afterKey, hash) : undefined);
    if (existing) {
      if (existing.hash !== hash) {
        return failure(
          "key_conflict",
          "This Idempotency-Key was already used with different commands.",
        );
      }
      if (headerKey && live(records.byKey(headerKey)) !== existing) {
        records.link(headerKey, existing);
        const operation = this.runner.lookup(`commands:${active.id}:${existing.id}`);
        if (operation) this.runner.bind(headerKey, hash, operation);
      }
      return this.respond(active, existing, deadline, true, body.eventsAfter);
    }
    if (records.full()) {
      records.relieve();
    }
    if (body.after && !records.valid(body.after)) {
      return failure(
        "invalid_operation_token",
        `Operation ${body.after} is unknown or expired. If you sent these commands before, check the page first, because they may have run. Then send again with the next value from this response.`,
        { next: records.issue() },
      );
    }
    if (
      [...active.jobs.values()].filter((job) => job.operation?.state === "queued").length >=
      this.limits.maxQueued
    ) {
      return failure("queue_full", "Too many executions are waiting in this session.", {}, 1);
    }
    if (records.full()) {
      return failure("records_full", "This session holds too many execution records.", {}, 5);
    }
    const execution = records.create({
      key: headerKey ?? afterKey,
      afterKey: headerKey ? afterKey : null,
      headerKey: idempotencyKey !== undefined,
      hash,
      mutating: body.commands.some(isMutating),
      after: body.after,
    });
    const job: Job = {
      execution,
      commands: body.commands,
      observe: body.observe,
      current: null,
      inflight: null,
      touched: false,
      cancelled: false,
    };
    active.jobs.set(execution.id, job);
    try {
      job.operation = this.runner.start(
        {
          id: execution.id,
          key: `commands:${active.id}:${execution.id}`,
          resource: this.resource,
          access: "exclusive",
          queueDeadline: deadline,
          timeoutMs: this.limits.executionLimitMs,
          beforeStart: async (operation) => {
            while (!this.ready && !active.ended) {
              await operation.wait(
                () =>
                  new Promise<void>((resolve) => {
                    this.readyListeners.add(resolve);
                    operation.signal.addEventListener(
                      "abort",
                      () => {
                        this.readyListeners.delete(resolve);
                        resolve();
                      },
                      { once: true },
                    );
                  }),
              );
            }
            operation.check();
            await operation.wait(() => this.host.quickActionsDone());
            await authorize?.();
          },
          onStop: async () => {
            const operation = job.operation!;
            if (execution.state === "queued") {
              if (operation.state === "expired") this.expire(active, execution);
              else
                this.finish(active, execution, "cancelled", {
                  code: "cancelled",
                  message: "The execution was cancelled before it started.",
                });
              return;
            }
            if (isFinal(execution.state)) return;
            job.cancelled = operation.state === "cancelled";
            const error =
              operation.state === "timeout"
                ? this.overtime()
                : { code: "cancelled", message: "The execution was cancelled." };
            this.interrupted(job, error);
            this.finish(
              active,
              execution,
              operation.state === "timeout" ? "timeout" : "cancelled",
              error,
            );
            job.interrupting = this.interrupt(active, job, this.limits.interruptGraceMs);
            await job.interrupting;
          },
        },
        async (operation) => {
          try {
            await this.run(active, job);
          } catch (error) {
            this.finish(active, execution, "failed", errorInfo(error));
          } finally {
            operation.state = execution.state;
            operation.effect = execution.effect;
            await job.interrupting;
          }
        },
      );
    } catch (error) {
      active.jobs.delete(execution.id);
      records.forget(execution);
      execution.state = "expired";
      execution.finishedAt = this.now();
      records.changed(execution);
      if ((error as { statusCode?: number }).statusCode === 429)
        return failure(
          "records_full",
          "Too many operations retain retry protection. Try again later.",
          {},
          5,
        );
      throw error;
    }
    if (headerKey) this.runner.bind(headerKey, hash, job.operation);
    if (afterKey) this.runner.bind(afterKey, hash, job.operation);
    void job.operation.promise
      .catch((error) => {
        // Admission failures happen before run() owns the execution. Settle its
        // public record too, so a refused queued operation cannot remain queued.
        if (!isFinal(execution.state)) this.finish(active, execution, "failed", errorInfo(error));
      })
      .finally(() => {
        if (isFinal(execution.state)) active.jobs.delete(execution.id);
      })
      .catch(() => undefined);
    return this.respond(active, execution, deadline, false, body.eventsAfter);
  }

  private async control(
    active: ActiveSession,
    command: Command,
    deadline: number,
    eventsAfter?: string,
  ): Promise<EngineResponse> {
    switch (command.command) {
      case "status":
        return this.status(active, command.execution, deadline, eventsAfter);
      case "cancel":
        return this.cancel(active, command.execution, deadline, eventsAfter);
      case "dialog":
        return this.answerDialog(active, command, eventsAfter);
      default:
        return failure("invalid_request", `${command.command} is not a control command.`);
    }
  }

  private async status(
    active: ActiveSession,
    id: string,
    deadline: number,
    eventsAfter?: string,
  ): Promise<EngineResponse> {
    const execution = active.records.get(id);
    if (!execution) {
      return unknownExecution(id);
    }
    await this.settle(active, execution, deadline);
    if (active.ended) {
      return ended(active.id);
    }
    return ok(await this.envelope(active, execution, false, eventsAfter));
  }

  private async cancel(
    active: ActiveSession,
    id: string,
    deadline: number,
    eventsAfter?: string,
  ): Promise<EngineResponse> {
    const execution = active.records.get(id);
    if (!execution) {
      return unknownExecution(id);
    }
    const operation = active.jobs.get(execution.id)?.operation;
    operation?.cancel();
    await operation?.stoppedCleanup();
    await this.settle(active, execution, deadline);
    if (active.ended) {
      return ended(active.id);
    }
    return ok(await this.envelope(active, execution, false, eventsAfter));
  }

  private async answerDialog(
    active: ActiveSession,
    command: Extract<Command, { command: "dialog" }>,
    eventsAfter?: string,
  ): Promise<EngineResponse> {
    const dialog = active.dialogs.get(command.dialog);
    if (!dialog || !dialog.open) {
      return failure(
        "dialog_not_pending",
        `Dialog ${command.dialog} is not open.`,
        dialog ? { dialog: describeDialog(dialog) } : {},
      );
    }
    await this.answer(active, dialog, command.action === "accept", command.text, "command");
    if (dialog.open) {
      dialog.by = undefined;
      return ok({
        error: {
          code: "internal_error",
          message: `Dialog ${dialog.id} did not close. It is still open, so answer it again.`,
        },
        dialog: describeDialog(dialog),
      });
    }
    active.records.bump();
    return ok({
      answered: describeDialog(dialog),
      epoch: active.records.epoch,
      ...(eventsAfter !== undefined ? { events: this.eventsSince(active, eventsAfter) } : {}),
    });
  }

  private async respond(
    active: ActiveSession,
    execution: Execution,
    deadline: number,
    replayed: boolean,
    eventsAfter?: string,
  ): Promise<EngineResponse> {
    await this.settle(active, execution, deadline);
    if (active.ended) {
      return ended(active.id);
    }
    if (execution.state === "queued") {
      this.expire(active, execution);
    }
    if (execution.state === "expired") {
      return failure(
        "expired",
        "The execution could not start before the response deadline. Send the same request again.",
        {},
        1,
      );
    }
    execution.next ??= active.records.issue(execution);
    return ok(await this.envelope(active, execution, replayed, eventsAfter));
  }

  private async settle(active: ActiveSession, execution: Execution, deadline: number) {
    while (!active.ended && !isFinal(execution.state) && this.now() < deadline) {
      await active.records.waitForChange(execution, deadline);
    }
  }

  private expire(active: ActiveSession, execution: Execution) {
    const job = active.jobs.get(execution.id);
    if (job?.operation?.active)
      job.operation.stop(new Error("Queued execution expired"), "expired");
    execution.state = "expired";
    execution.finishedAt = this.now();
    active.records.changed(execution);
  }

  private async envelope(
    active: ActiveSession,
    execution: Execution,
    replayed: boolean,
    eventsAfter?: string,
  ): Promise<Record<string, unknown>> {
    if (isFinal(execution.state) && execution.page === undefined) {
      execution.page = (await within(pageInfo(active, execution.tab), STEP_MS)) ?? null;
    }
    const page = isFinal(execution.state)
      ? (execution.page ?? null)
      : ((await within(pageInfo(active, execution.tab), STEP_MS)) ?? null);
    return {
      ...(execution.next ? { next: execution.next } : {}),
      epoch: active.records.epoch,
      ...(execution.epochChanged !== undefined ? { epochChanged: execution.epochChanged } : {}),
      page,
      execution: {
        id: execution.id,
        state: execution.state,
        effect: execution.effect,
        replayed,
        ran: execution.ran,
        ...(execution.error ? { error: execution.error } : {}),
      },
      results: execution.results,
      ...dialogNote(active, execution.tab ? active.tabs.get(execution.tab) : undefined),
      ...(execution.observe ? { observe: execution.observe } : {}),
      ...(execution.bodyExpired ? { bodyExpired: true } : {}),
      ...(eventsAfter !== undefined ? { events: this.eventsSince(active, eventsAfter) } : {}),
    };
  }

  private eventsSince(active: ActiveSession, cursor: string) {
    const requested = Number(cursor.slice(2));
    const stale = requested > active.eventSequence;
    const after = stale ? 0 : requested;
    const pending = active.events.filter((event) => event.id > after);
    const items = pending.slice(0, EVENTS_PER_RESPONSE);
    const oldest = active.events[0]?.id ?? active.eventSequence + 1;
    const last = pending.length > items.length ? items[items.length - 1].id : active.eventSequence;
    return {
      cursor: `c-${Math.max(last, after)}`,
      items: items.map(({ id, ...event }) => ({ id: `c-${id}`, ...event })),
      ...(stale || (after < oldest - 1 && after < active.eventSequence) ? { truncated: true } : {}),
      ...(pending.length > items.length ? { more: true } : {}),
    };
  }

  private record(
    active: ActiveSession,
    type: string,
    tab: string,
    fields: Record<string, unknown>,
  ) {
    if (this.active !== active) {
      return;
    }
    active.events.push({
      id: ++active.eventSequence,
      type,
      tab,
      at: new Date(this.now()).toISOString(),
      ...fields,
    });
    if (active.events.length > KEPT_EVENTS) {
      active.events.splice(0, active.events.length - KEPT_EVENTS);
    }
  }

  private async run(active: ActiveSession, job: Job) {
    const { execution } = job;
    execution.state = "running";
    execution.startedAt = this.now();

    if (execution.after) {
      execution.epochChanged = active.records.epochChangedSince(execution);
    }
    active.records.changed(execution);
    for (const command of job.commands) {
      if (await this.stopped(active, job)) {
        return;
      }
      job.touched = false;
      job.tab = undefined;
      execution.ran++;
      const ctx = this.context(active, job);
      const result = await this.track(active, job, command, ctx, execute(ctx, command));
      if (!result) {
        return;
      }
      execution.results.push(result);
      execution.effect = combine(execution.results);
      if (!result.ok) {
        break;
      }
    }
    if (job.observe && job.observe.mode !== "none") {
      if (await this.stopped(active, job)) {
        return;
      }
      job.touched = false;
      const ctx = this.context(active, job);
      const observed = await this.track(active, job, null, ctx, observe(ctx, job.observe));
      if (!observed) {
        return;
      }
      execution.observe = observed;
    }
    if (await this.stopped(active, job)) {
      return;
    }
    execution.page = (await within(pageInfo(active, execution.tab), STEP_MS)) ?? null;
    this.finish(
      active,
      execution,
      execution.results.every((result) => result.ok) ? "completed" : "failed",
    );
  }

  private context(active: ActiveSession, job: Job): Context {
    return {
      active,
      job,
      host: this.host,
      limits: this.limits,
      now: this.now,
      group: handleGroup(),
    };
  }

  private async stopped(active: ActiveSession, job: Job): Promise<boolean> {
    if (this.active === active && this.host.released(active.id)) {
      this.sessionEnded();
    }
    if (active.ended || isFinal(job.execution.state)) {
      return true;
    }
    if (job.cancelled) {
      this.finish(active, job.execution, "cancelled", {
        code: "cancelled",
        message: "The execution was cancelled.",
      });
      return true;
    }
    if (this.now() >= job.operation!.deadline) {
      job.operation!.stop(new Error(this.overtime().message), "timeout");
      await job.operation!.stoppedCleanup();
      return true;
    }
    return false;
  }

  private async track<T>(
    active: ActiveSession,
    job: Job,
    command: Command | null,
    ctx: Context,
    pending: Promise<T>,
  ): Promise<T | undefined> {
    job.current = command;
    job.inflight = pending;
    let settled = false;
    try {
      for (;;) {
        if (active.ended || isFinal(job.execution.state)) {
          return undefined;
        }
        const remaining = job.cancelled
          ? STEP_MS
          : Math.min(job.operation!.deadline - this.now(), STEP_MS);
        if (remaining <= 0) {
          job.operation!.stop(new Error(this.overtime().message), "timeout");
          await job.operation!.stoppedCleanup();
          return undefined;
        }
        const tab = job.tab ? active.tabs.get(job.tab) : undefined;
        const watch = tab
          ? watchBlocking(tab, !(command && RECOVERS.has(command.command)))
          : undefined;
        let result = await within<T | typeof BLOCKED>(
          watch
            ? Promise.race<T | typeof BLOCKED>([
                pending,
                watch.promise.then((): typeof BLOCKED => BLOCKED),
              ])
            : pending,
          remaining,
        ).finally(() => watch?.stop());
        if (result === BLOCKED) {
          result = await within(pending, BLOCKED_GRACE_MS);
          if (result === undefined) {
            if (tab && !tab.blocking && !tab.crashed) {
              continue;
            }
            return this.blockedResult(active, job, command) as T;
          }
        }
        if (result !== undefined) {
          settled = true;
          return active.ended || isFinal(job.execution.state) ? undefined : (result as T);
        }
      }
    } finally {
      job.current = null;
      job.inflight = null;
      if (!settled) {
        ctx.abandoned = true;
      }
    }
  }

  private blockedResult(active: ActiveSession, job: Job, command: Command | null) {
    const tab = job.tab ? active.tabs.get(job.tab) : undefined;
    if (tab?.crashed && !tab.blocking) {
      const error = { code: "tab_crashed", message: crashedTab(tab).message };
      return command ? { ok: false, effect: job.touched ? "unknown" : "none", error } : { error };
    }
    const dialog = openDialogOn(active, job.tab);
    const error = {
      code: "dialog_pending",
      message: dialog
        ? `Tab ${dialog.tab} shows ${dialog.type} dialog ${dialog.id}: "${dialog.message}". Answer it with the dialog command.`
        : "A dialog opened and blocked the page. Answer it with the dialog command.",
    };
    if (!command) {
      return { error };
    }
    return { ok: false, effect: job.touched ? "unknown" : "none", error };
  }

  private interrupted(job: Job, error: ErrorInfo) {
    if (job.current && !isFinal(job.execution.state)) {
      job.execution.results.push({
        ok: false,
        effect: job.touched ? "unknown" : "none",
        error,
      });
    }
  }

  private async interrupt(active: ActiveSession, job: Job, grace: number): Promise<boolean> {
    const pending = job.inflight;
    if (!pending) {
      return true;
    }
    const tab = job.tab ? active.tabs.get(job.tab) : undefined;
    const settles = async (ms: number) =>
      (await within(
        pending.then(() => true),
        ms,
      )) === true;
    if (await settles(grace)) {
      return true;
    }
    const steps: Array<() => Promise<unknown> | undefined> = [
      () => tab?.stopLoading(),
      () => tab?.terminate(),
      ...(job.touched && tab
        ? [
            () => tab?.release(),
            () => (tab && !tab.closed ? this.closeTab(active, tab) : undefined),
            () => this.endFor(active),
          ]
        : []),
    ];
    for (const step of steps) {
      const running = Promise.resolve()
        .then(step)
        .catch(() => undefined);
      await within(running, STEP_MS);
      if (await settles(STEP_MS)) {
        await within(running, STEP_MS);
        return true;
      }
    }
    return false;
  }

  private endFor(active: ActiveSession) {
    if (this.active !== active || active.ended || active.ending || this.host.released(active.id)) {
      return undefined;
    }
    active.ending = true;
    return this.host.endSession(active.id);
  }

  private async closeTab(active: ActiveSession, tab: Tab) {
    if (active.tabs.list().filter((other) => !other.closed).length <= 1) {
      await active.tabs.create();
    }
    await active.tabs.close(tab);
  }

  private overtime(): ErrorInfo {
    return {
      code: "timeout",
      message: `The execution ran longer than ${this.limits.executionLimitMs / 1000} seconds.`,
    };
  }

  private finish(
    active: ActiveSession,
    execution: Execution,
    state: ExecutionState,
    error?: ErrorInfo,
  ) {
    if (isFinal(execution.state)) {
      return;
    }
    execution.state = state;
    if (error) {
      execution.error = error;
    }
    execution.effect = combine(execution.results);
    execution.finishedAt = this.now();
    if (execution.mutating && execution.effect !== "none") {
      active.records.bump(execution);
    }
    active.records.changed(execution);
  }

  private restart(active: ActiveSession) {
    const error = {
      code: "browser_restarted",
      message: "The browser restarted, so tabs and refs changed. Run tab list again.",
    };
    for (const job of active.jobs.values()) {
      this.interrupted(job, error);
      this.finish(active, job.execution, "failed", error);
      job.operation?.cancel(new Error(error.message));
    }
    this.closeDialogs(active);
    active.refs.retire();
    active.records.bump();
    active.browser = null;
  }

  private end(active: ActiveSession) {
    active.ended = true;
    const error = { code: "session_ended", message: "The session ended." };
    for (const job of active.jobs.values()) {
      this.interrupted(job, error);
      this.finish(active, job.execution, "failed", error);
      job.operation?.cancel(new Error(error.message));
    }
    for (const resolve of this.readyListeners) resolve();
    this.readyListeners.clear();
    this.closeDialogs(active);
    active.tabs.detach();
  }

  private dialogOpened(
    active: ActiveSession,
    tab: Tab,
    event: Protocol.Page.JavascriptDialogOpeningEvent,
  ) {
    if (this.active !== active) {
      return;
    }
    this.remember(active, openDialog(`d-${++active.dialogSequence}`, tab.id, event));
    tab.markBlocking();
  }

  private dialogClosed(
    active: ActiveSession,
    tab: Tab,
    event: Protocol.Page.JavascriptDialogClosedEvent,
  ) {
    const dialog = openDialogOn(active, tab.id);
    if (!dialog) {
      return;
    }
    this.finishDialog(
      active,
      dialog,
      event.result,
      event.userInput || undefined,
      dialog.by ?? "client",
    );
    if (tab.holding()) {
      void tab.release().catch(() => undefined);
    }
  }

  private finishDialog(
    active: ActiveSession,
    dialog: Dialog,
    accepted: boolean,
    text: string | undefined,
    by: DialogHandler,
  ) {
    dialog.accepted = accepted;
    dialog.text = text;
    dialog.by = by;
    this.closeDialog(dialog);
    this.record(active, "dialog", dialog.tab, { dialog: describeDialog(dialog) });
  }

  private async answer(
    active: ActiveSession,
    dialog: Dialog,
    accept: boolean,
    text: string | undefined,
    by: DialogHandler,
  ) {
    if (!dialog.open) {
      return;
    }
    dialog.by = by;
    const promptText =
      dialog.type === "prompt" && accept ? (text ?? dialog.defaultPrompt ?? "") : undefined;
    await active.tabs
      .get(dialog.tab)
      ?.answerDialog(accept, promptText)
      .catch(() => undefined);
    await within(dialog.closed, STEP_MS);
  }

  private remember(active: ActiveSession, dialog: Dialog) {
    active.dialogs.set(dialog.id, dialog);
    for (const [id, candidate] of active.dialogs) {
      if (active.dialogs.size <= this.limits.maxDialogs) {
        return;
      }
      if (!candidate.open) {
        active.dialogs.delete(id);
      }
    }
  }

  private closeDialog(dialog: Dialog) {
    dialog.open = false;
    dialog.close();
  }

  private closeDialogs(active: ActiveSession) {
    for (const dialog of active.dialogs.values()) {
      if (dialog.open) {
        this.closeDialog(dialog);
      }
    }
  }
}

function ok(body: Record<string, unknown>): EngineResponse {
  return { status: 200, headers: {}, body };
}

function failure(
  code: RequestErrorCode,
  message: string,
  fields: Record<string, unknown> = {},
  retryAfter?: number,
): EngineResponse {
  return {
    status: statusFor(code),
    headers: retryAfter ? { "retry-after": String(retryAfter) } : {},
    body: { ...fields, error: { code, message } },
  };
}

function ended(sessionId: string): EngineResponse {
  return failure("session_ended", `Session ${sessionId} is not running in this browser.`);
}

function unknownExecution(id: string): EngineResponse {
  return failure("unknown_execution", `Execution ${id} is not known in this session.`);
}
