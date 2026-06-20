import { io, type Socket } from 'socket.io-client';

import type { MessageRecord } from './contracts';

interface JoinAck {
  ok: boolean;
  chatId?: string;
  error?: string;
}

interface MessageSendAck {
  ok: boolean;
  message?: MessageRecord;
  error?: string;
}

export class SocketHelper {
  private readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
  }

  static async connect(baseUrl: string, token: string): Promise<SocketHelper> {
    const socket: Socket = io(baseUrl, {
      path: '/socket.io',
      auth: {
        token: `Bearer ${token}`
      },
      timeout: 5_000
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('socket.io connect timed out'));
      }, 5_000);

      socket.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    return new SocketHelper(socket);
  }

  async join(chatId: string): Promise<void> {
    const ack = await this.emitWithAck<JoinAck>('join', { chatId });

    if (!ack.ok) {
      throw new Error(`socket join failed: ${ack.error ?? 'unknown error'}`);
    }
  }

  async sendMessage(chatId: string, body: string): Promise<MessageRecord> {
    const ack = await this.emitWithAck<MessageSendAck>('message:send', { chatId, body });

    if (!ack.ok || ack.message === undefined) {
      throw new Error(`socket message:send failed: ${ack.error ?? 'missing message ack'}`);
    }

    return ack.message;
  }

  waitForMessage(body: string): Promise<MessageRecord> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket.off('message:new', handler);
        reject(new Error(`Timed out waiting for message:new body=${body}`));
      }, 7_500);
      const handler = (message: MessageRecord) => {
        if (message.body === body) {
          clearTimeout(timeout);
          this.socket.off('message:new', handler);
          resolve(message);
        }
      };

      this.socket.on('message:new', handler);
    });
  }

  close(): void {
    this.socket.disconnect();
  }

  private emitWithAck<T>(eventName: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`socket emit timed out event=${eventName}`));
      }, 5_000);

      this.socket.emit(eventName, payload, (ack: T) => {
        clearTimeout(timeout);
        resolve(ack);
      });
    });
  }
}
