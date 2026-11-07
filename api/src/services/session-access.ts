// Compatibility entry points for HTTP and CDP adapters. Access policy belongs
// to the operation runner; a login uses the same resource with exclusive access.
import { operations, type Operation } from "./operations.js";
type Session = { loginBusy?: boolean };
export function beginSessionOperation(session: Session): () => void {
  return operations.enter(session);
}
export function withSessionOperation<T>(
  session: Session,
  run: (operation: Operation<any>) => Promise<T>,
): Promise<T> {
  return operations.run({ resource: session, timeoutMs: 180_000 }, async (operation) => {
    operation.markActed();
    return run(operation);
  });
}
export async function withSessionLogin<T>(
  session: Session,
  run: (operation: Operation<any>) => Promise<T>,
): Promise<T> {
  if (session.loginBusy)
    throw Object.assign(new Error("Login already running"), { statusCode: 409 });
  session.loginBusy = true;
  const operation = operations.start<T>(
    {
      resource: session,
      access: "exclusive",
      queueDeadline: Date.now() + 30_000,
      timeoutMs: 600_000,
    },
    async (operation) => {
      return run(operation);
    },
  );
  void operation.done.then(() => {
    session.loginBusy = false;
  });
  return operation.promise;
}
