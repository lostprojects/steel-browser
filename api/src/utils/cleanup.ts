// Release resources in order, attempting every step even when an earlier one fails.
// Keep the original errors together so cleanup cannot hide a failed release.
export async function runCleanup(steps: Iterable<() => unknown>, message: string): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, message);
}
