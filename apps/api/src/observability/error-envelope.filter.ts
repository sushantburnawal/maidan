import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus
} from '@nestjs/common';

import {
  getCorrelationId,
  getRequestId,
  normalizeHeaderId,
  newRequestId
} from './request-context';
import { writeJsonLog } from './json-logger';

interface HttpRequestLike {
  headers?: Record<string, unknown>;
  method?: string;
  url?: string;
}

interface HttpResponseLike {
  status(code: number): HttpResponseLike;
  send(payload: unknown): void;
}

interface ErrorEnvelope {
  error: {
    code: string;
    correlation_id: string;
    message: string;
    request_id: string;
    details?: unknown;
  };
}

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<HttpResponseLike>();
    const statusCode = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const errorBody = exception instanceof HttpException ? exception.getResponse() : undefined;
    const message = errorMessage(errorBody, exception, statusCode);
    const requestId =
      getRequestId() ??
      normalizeHeaderId(request.headers?.['x-request-id']) ??
      normalizeHeaderId(request.headers?.['x-correlation-id']) ??
      newRequestId();
    const correlationId =
      getCorrelationId() ??
      normalizeHeaderId(request.headers?.['x-correlation-id']) ??
      normalizeHeaderId(request.headers?.['x-request-id']) ??
      requestId;
    const envelope: ErrorEnvelope = {
      error: {
        code: errorCode(errorBody, statusCode),
        correlation_id: correlationId,
        message,
        request_id: requestId
      }
    };
    const details = errorDetails(errorBody);

    if (details !== undefined) {
      envelope.error.details = details;
    }

    if (statusCode >= 500) {
      writeJsonLog('error', 'http_request_failed', {
        status_code: statusCode,
        error: exception instanceof Error ? exception.stack : String(exception),
        method: request.method,
        path: request.url
      });
    }

    response.status(statusCode).send(envelope);
  }
}

function errorMessage(errorBody: unknown, exception: unknown, statusCode: number): string {
  if (typeof errorBody === 'string') {
    return errorBody;
  }

  if (isRecord(errorBody)) {
    const bodyMessage = errorBody.message;

    if (typeof bodyMessage === 'string') {
      return bodyMessage;
    }

    if (Array.isArray(bodyMessage)) {
      return 'Validation failed';
    }
  }

  if (exception instanceof Error && statusCode < 500) {
    return exception.message;
  }

  if (statusCode >= 500) {
    return 'Internal server error';
  }

  return 'Request failed';
}

function errorCode(errorBody: unknown, statusCode: number): string {
  if (isRecord(errorBody) && typeof errorBody.error === 'string') {
    return toConstantCase(errorBody.error);
  }

  switch (statusCode) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'TOO_MANY_REQUESTS';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'SERVICE_UNAVAILABLE';
    default:
      return statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED';
  }
}

function errorDetails(errorBody: unknown): unknown {
  if (!isRecord(errorBody)) {
    return undefined;
  }

  if (Array.isArray(errorBody.message)) {
    return {
      validation_errors: errorBody.message
    };
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toConstantCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}
