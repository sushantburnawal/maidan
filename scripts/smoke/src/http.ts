import { randomUUID } from 'node:crypto';

import { formatValue } from './assert';

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, QueryValue>;
  correlationId?: string;
}

export interface RawHttpResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  correlationId?: string;
  error?: SmokeHttpError;
}

export class SmokeHttpError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly correlationId: string | undefined,
    readonly responseBody: unknown
  ) {
    super(message);
    this.name = 'SmokeHttpError';
  }
}

export class HttpClient {
  constructor(private readonly baseUrl: string) {}

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  async post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, {
      ...options,
      body
    });
  }

  async patch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', path, {
      ...options,
      body
    });
  }

  async text(method: 'GET' | 'POST', path: string, options: RequestOptions = {}): Promise<string> {
    const response = await this.fetch(method, path, options);
    const bodyText = await response.text();

    if (!response.ok) {
      throw await this.toHttpError(method, path, response, bodyText);
    }

    return bodyText;
  }

  async raw<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: RequestOptions = {}
  ): Promise<RawHttpResult<T>> {
    try {
      const body = await this.request<T>(method, path, options);

      return {
        ok: true,
        status: 200,
        body
      };
    } catch (error) {
      if (error instanceof SmokeHttpError) {
        return {
          ok: false,
          status: error.status,
          body: error.responseBody as T | null,
          correlationId: error.correlationId,
          error
        };
      }

      throw error;
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: RequestOptions
  ): Promise<T> {
    const response = await this.fetch(method, path, options);
    const bodyText = await response.text();

    if (!response.ok) {
      throw await this.toHttpError(method, path, response, bodyText);
    }

    if (bodyText.length === 0) {
      return undefined as T;
    }

    return JSON.parse(bodyText) as T;
  }

  private async fetch(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: RequestOptions
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-correlation-id': options.correlationId ?? `smoke-${randomUUID()}`
    };

    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    if (options.token !== undefined) {
      headers.authorization = `Bearer ${options.token}`;
    }

    Object.assign(headers, options.headers);

    const url = this.url(path, options.query);

    try {
      return await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch (error) {
      throw new Error(
        `${method} ${path} failed to reach ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async toHttpError(
    method: string,
    path: string,
    response: Response,
    bodyText: string
  ): Promise<SmokeHttpError> {
    const body = parseJsonBody(bodyText);
    const correlationId = extractCorrelationId(body) ?? response.headers.get('x-correlation-id') ?? undefined;
    const message = `${method} ${path} returned ${response.status}${
      correlationId === undefined ? '' : ` correlation_id=${correlationId}`
    }\nresponse: ${formatValue(body)}`;

    return new SmokeHttpError(message, method, path, response.status, correlationId, body);
  }

  private url(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);

    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }
}

function parseJsonBody(bodyText: string): unknown {
  if (bodyText.length === 0) {
    return null;
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

function extractCorrelationId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }

  const error = (body as { error?: unknown }).error;

  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return undefined;
  }

  const correlationId = (error as { correlation_id?: unknown }).correlation_id;

  return typeof correlationId === 'string' ? correlationId : undefined;
}
