// Inspect only process metadata, never argv or environment (which may contain
// credentials). Quiet Chrome owns a process group so crash cleanup is scoped.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export async function chromeProcesses(group: number) {
  const { stdout } = await execute("ps", ["-e", "-o", "pid=,pgid=,rss=,stat="], {
    maxBuffer: 1024 * 1024,
  });
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, pgid, rss, state] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        group: Number(pgid),
        rssBytes: Number(rss) * 1024,
        zombie: state.startsWith("Z"),
      };
    })
    .filter((row) => row.group === group);
}
export async function killChromeGroup(group: number) {
  if (!Number.isInteger(group) || group <= 1 || group === process.pid)
    throw new Error("Invalid Chrome process group");
  try {
    process.kill(-group, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  for (let i = 0; i < 50; i++) {
    const remaining = await chromeProcesses(group);
    if (!remaining.length) return { remainingProcesses: 0, remainingZombies: 0 };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const remaining = await chromeProcesses(group);
  return {
    remainingProcesses: remaining.filter((p) => !p.zombie).length,
    remainingZombies: remaining.filter((p) => p.zombie).length,
  };
}
