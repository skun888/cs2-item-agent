export type ErrorCode =
  | "CONFIG_ERROR"
  | "HTTP_ERROR"
  | "PROVIDER_ERROR"
  | "CONTRACT_ERROR"
  | "INVENTORY_ERROR"
  | "NOTIFICATION_ERROR"
  | "USAGE_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function toPublicError(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : "Unknown error",
    },
  };
}
