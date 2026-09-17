/** Thrown for any non-2xx response. Carries the parsed error body, when there was one. */
export class AgentCorrespondentApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const code = typeof (body as { error?: unknown })?.error === "string"
      ? (body as { error: string }).error
      : undefined;
    const message =
      typeof (body as { message?: unknown })?.message === "string"
        ? (body as { message: string }).message
        : `Agent Correspondent API returned ${status}`;
    super(message);
    this.name = "AgentCorrespondentApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}
