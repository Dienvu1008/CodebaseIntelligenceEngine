/**
 * Plain, serializable domain error. It is not an `Error` subclass on purpose: domain errors are data that
 * travel inside `Result`, and they never carry stack traces (API-003).
 */
export interface DomainError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function domainError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): DomainError {
  return details === undefined ? { code, message } : { code, message, details };
}
