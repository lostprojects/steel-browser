// Coordinate client work with service-owned login input. Normal work stays
// concurrent; only a login waits for existing work and holds new REST requests.
type Session = { loginBusy?: boolean; engine?: { busy(): boolean } };
type Access = { operations: number; login?: Promise<void> };
const access = new WeakMap<Session, Access>();
function state(session: Session): Access {
  let value = access.get(session);
  if (!value) access.set(session, (value = { operations: 0 }));
  return value;
}
const busy = () =>
  Object.assign(new Error("Browser login is waiting for active work to finish"), {
    statusCode: 409,
  });

export function beginSessionOperation(session: Session): () => void {
  const value = state(session);
  if (session.loginBusy || value.login) throw busy();
  value.operations++;
  let finished = false;
  return () => {
    if (!finished) value.operations--;
    finished = true;
  };
}

export async function withSessionOperation<T>(session: Session, run: () => Promise<T>): Promise<T> {
  const value = state(session);
  while (value.login) await value.login;
  const finish = beginSessionOperation(session);
  try {
    return await run();
  } finally {
    finish();
  }
}

export async function withSessionLogin<T>(session: Session, run: () => Promise<T>): Promise<T> {
  const value = state(session);
  if (session.loginBusy || value.login) throw busy();
  let finish!: () => void;
  value.login = new Promise<void>((resolve) => {
    finish = resolve;
  });
  session.loginBusy = true;
  const deadline = Date.now() + 30_000;
  try {
    // CDP replies and HTTP operations release their own entries. A queued
    // commands job can outlive its HTTP response, so also wait for that engine.
    while (value.operations || session.engine?.busy()) {
      if (Date.now() >= deadline) throw busy();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await run();
  } finally {
    session.loginBusy = false;
    value.login = undefined;
    finish();
  }
}
