export class ApplicationError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}
