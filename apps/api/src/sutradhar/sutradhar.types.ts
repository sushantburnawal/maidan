import type { Readable } from 'node:stream';

export interface SutradharProxyResponse {
  contentType: string;
  body: Readable;
}
