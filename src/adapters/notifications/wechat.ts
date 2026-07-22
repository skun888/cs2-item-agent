import { AppError } from "../../core/errors.js";

export interface WechatNotifierOptions {
  readonly webhookUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface NotificationResult {
  readonly status: "sent";
  readonly message: string;
  readonly attemptCount: number;
}

export interface NotificationRetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export class WechatNotifier {
  readonly #webhookUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: WechatNotifierOptions) {
    this.#webhookUrl = options.webhookUrl;
    this.#fetch = options.fetchFn ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async sendText(content: string): Promise<NotificationResult> {
    let response: Response;
    try {
      response = await this.#fetch(this.#webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: content.slice(0, 4_000) } }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new AppError(
        "NOTIFICATION_ERROR",
        error instanceof Error ? `Enterprise WeChat request failed: ${error.message}` : "Enterprise WeChat request failed.",
      );
    }
    if (!response.ok) {
      throw new AppError("NOTIFICATION_ERROR", `Enterprise WeChat returned HTTP ${response.status}.`);
    }
    const payload = await safeJson(response);
    const errcode = typeof payload.errcode === "number" ? payload.errcode : undefined;
    if (errcode !== 0) {
      throw new AppError("NOTIFICATION_ERROR", "Enterprise WeChat rejected the notification.", {
        ...(errcode !== undefined ? { providerCode: errcode } : {}),
        ...(typeof payload.errmsg === "string" ? { providerMessage: payload.errmsg } : {}),
      });
    }
    return { status: "sent", message: "Enterprise WeChat notification sent.", attemptCount: 1 };
  }

  async sendTextWithRetry(
    content: string,
    options: NotificationRetryOptions = {},
  ): Promise<NotificationResult> {
    const maxAttempts = options.maxAttempts ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 500;
    const delay = options.delay ?? wait;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      throw new AppError("CONFIG_ERROR", "Enterprise WeChat maxAttempts must be from 1 to 5.");
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.sendText(content);
        return { ...result, attemptCount: attempt };
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) await delay(baseDelayMs * 2 ** (attempt - 1));
      }
    }
    if (lastError instanceof AppError) {
      throw new AppError(lastError.code, lastError.message, {
        ...lastError.details,
        attemptCount: maxAttempts,
      });
    }
    throw new AppError("NOTIFICATION_ERROR", "Enterprise WeChat notification failed after retries.", {
      attemptCount: maxAttempts,
    });
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function safeJson(response: Response): Promise<Readonly<Record<string, unknown>>> {
  try {
    const payload: unknown = await response.json();
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Readonly<Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
}
