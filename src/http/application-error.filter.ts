import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApplicationError } from '../application/errors.ts';
import { DomainValidationError } from '../domain/errors.ts';

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

@Catch()
export class ApplicationErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();

    if (error instanceof ApplicationError) {
      if (error.retryAfterSeconds !== undefined) {
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      response.status(error.httpStatus).json({ code: error.code, message: error.message });
      return;
    }

    if (error instanceof DomainValidationError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        code: 'INVALID_PAYLOAD',
        message: error.message,
      });
      return;
    }

    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }

    if (isTransientInfrastructureError(error)) {
      response.setHeader('Retry-After', '3');
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A required dependency is temporarily unavailable.',
      });
      return;
    }

    console.error(JSON.stringify({
      level: 'error',
      event: 'unhandled_application_error',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorCode: getErrorProperty(error, 'code'),
      constraint: getErrorProperty(error, 'constraint'),
    }));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed.',
    });
  }
}

function getErrorProperty(error: unknown, property: 'code' | 'constraint'): string | undefined {
  if (typeof error !== 'object' || error === null || !(property in error)) {
    return undefined;
  }
  const value: unknown = Reflect.get(error, property);
  return value === undefined || value === null ? undefined : String(value);
}

function isTransientInfrastructureError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = String(error.code);
  return code.startsWith('08')
    || code.startsWith('ECONN')
    || code === 'ETIMEDOUT'
    || code === '57P01'
    || code === '53300'
    || code === '40001';
}
