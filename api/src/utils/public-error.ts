// Only explicitly public failures cross protocol boundaries. Unexpected errors
// keep their details inside the service, where they can include credentials.
export class PublicError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}
