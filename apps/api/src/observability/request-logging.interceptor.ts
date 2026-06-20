import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

import { writeJsonLog } from './json-logger';

interface HttpRequestLike {
  method?: string;
  url?: string;
}

interface HttpResponseLike {
  statusCode?: number;
}

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<HttpResponseLike>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          writeJsonLog('info', 'http_request_completed', {
            method: request.method,
            path: request.url,
            status_code: response.statusCode,
            duration_ms: Date.now() - startedAt
          });
        },
        error: (error: unknown) => {
          writeJsonLog('warn', 'http_request_error', {
            method: request.method,
            path: request.url,
            status_code: response.statusCode,
            duration_ms: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })
    );
  }
}
