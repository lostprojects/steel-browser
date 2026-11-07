import type { Command } from "../commands.js";
import { diffSnapshots } from "../diff.js";
import { CommandError } from "../errors.js";
import { checkUrl } from "../policy.js";
import type { CommandResult } from "../records.js";
import { combine, errorInfo, failed } from "../results.js";
import type { Observe } from "../session.js";
import { refsFor, scanSecrets } from "../snapshot.js";
import { callIn, locate } from "../targets.js";
import { SECRET_VALUES, secretsWithin } from "../secrets.js";
import { textPage, type TextRange } from "../../../utils/text.js";
import {
  capture,
  ending,
  goto,
  navigationDone,
  optionsKey,
  scopeFor,
  tabFor,
  touch,
  usable,
  useTab,
  type Context,
} from "./context.js";

const FIND_LIMIT = 50;

export async function snapshot(
  ctx: Context,
  command: Extract<Command, { command: "snapshot" }>,
): Promise<CommandResult> {
  if (command.snapshotId) {
    const kept = ctx.active.kept.get(command.snapshotId);
    if (!kept) throw new CommandError("invalid_argument", "Snapshot expired; take a new snapshot.");
    if (command.tab && command.tab !== kept.tab)
      throw new CommandError("invalid_argument", "Snapshot belongs to a different tab.");
    useTab(ctx, kept.tab);
    return {
      ok: true,
      effect: "none",
      ...snapshotPage({ snapshotId: command.snapshotId, snapshot: kept.text }, command),
    };
  }
  const tab = tabFor(ctx, command.tab);
  const { command: _, tab: __, snapshotId: ___, ...options } = command;
  return {
    ok: true,
    effect: "none",
    ...snapshotPage(
      await capture(ctx.active, tab, options, () => !ending(ctx), ctx.limits),
      options,
    ),
  };
}

function snapshotPage(captured: { snapshotId: string; snapshot: string }, range: TextRange) {
  if (range.offset === undefined && range.limit === undefined) return captured;
  const { value, ...page } = textPage(captured.snapshot, range);
  return { snapshotId: captured.snapshotId, snapshot: value, ...page };
}

export async function find(
  ctx: Context,
  command: Extract<Command, { command: "find" }>,
): Promise<CommandResult> {
  if (command.name !== undefined && command.by !== "role") {
    throw new CommandError("invalid_argument", "name works only with by: role.");
  }
  const tab = tabFor(ctx, command.tab);
  const scope = await scopeFor(ctx, tab, command.frame);
  const matches = await locate(scope, {
    [command.by]: command.value,
    ...(command.name !== undefined ? { name: command.name } : {}),
    ...(command.exact !== undefined ? { exact: command.exact } : {}),
  });
  const scan = await scanSecrets(scope.session);
  const secrets = [
    ...(await callIn<string[]>(scope, SECRET_VALUES).catch(() => [])),
    ...scan.values,
  ];
  const shown = matches.slice(0, FIND_LIMIT).map((match) => match.backendNodeId);
  const within = new Map<number, string[]>();
  for (const backendNodeId of shown) {
    within.set(backendNodeId, [
      ...(await secretsWithin(scope.session, backendNodeId)),
      ...scan.within(backendNodeId),
    ]);
  }
  const found = await refsFor(
    { ...scope, tabId: tab.id, sessionKey: scope.session.id() },
    ctx.active.refs,
    shown,
    secrets,
    within,
    () => !ending(ctx),
  );
  return { ok: true, effect: "none", count: matches.length, matches: found };
}

export async function tab(
  ctx: Context,
  command: Extract<Command, { command: "tab" }>,
): Promise<CommandResult> {
  const { active } = ctx;
  switch (command.action) {
    case "list":
      return { ok: true, effect: "none", tabs: await active.tabs.describe() };
    case "new": {
      const url = command.url ? checkUrl(command.url) : undefined;
      touch(ctx);
      const opened = await active.tabs.create();
      useTab(ctx, opened.id);
      if (url) {
        try {
          await goto(ctx, opened, url);
        } catch (error) {
          const result = failed(error, "unknown");
          return {
            ...result,
            effect: combine([result, { ok: true, effect: "applied" }]),
            tab: opened.id,
          };
        }
      }
      return { ok: true, effect: "applied", tab: opened.id };
    }
    case "close": {
      const closing = active.tabs.resolve(command.tab);
      if (active.tabs.list().length === 1) {
        throw new CommandError(
          "invalid_argument",
          `Tab ${closing.id} is the last open tab. Open another tab before closing it.`,
          "last_tab",
        );
      }
      touch(ctx);
      await active.tabs.close(closing);
      return { ok: true, effect: "applied", tab: closing.id };
    }
  }
}

export async function observe(ctx: Context, observe: Observe): Promise<Record<string, unknown>> {
  const { active, job } = ctx;
  try {
    const tab = active.tabs.resolve(observe.tab ?? job.execution.tab);
    useTab(ctx, tab.id);
    await navigationDone(ctx, tab);
    const current = usable(ctx, tab);
    const { mode, base, tab: _, ...options } = observe;
    const baseId = mode === "diff" ? (base ?? active.latest.get(current.id)) : undefined;
    const before = baseId ? active.kept.get(baseId) : undefined;
    const captured = await capture(active, current, options, () => !ending(ctx), ctx.limits);
    const full = snapshotPage(captured, options);
    if (mode !== "diff") {
      return full;
    }
    const diff =
      before &&
      before.tab === current.id &&
      before.options === optionsKey(options) &&
      !options.offset &&
      !("nextOffset" in full) &&
      before.text.length <= (options.limit ?? Infinity)
        ? diffSnapshots(before.text, captured.snapshot)
        : null;
    const replacement = { ...full, full: true };
    if (!diff) {
      return replacement;
    }
    const delta = {
      snapshotId: captured.snapshotId,
      base: baseId,
      diff: diff.diff,
      additions: diff.additions,
      removals: diff.removals,
    };
    return JSON.stringify(delta).length < JSON.stringify(replacement).length ? delta : replacement;
  } catch (error) {
    return { error: errorInfo(error) };
  }
}
