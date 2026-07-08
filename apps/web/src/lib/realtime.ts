import { io, type Socket } from 'socket.io-client';
import type { Booking, DomainEventRecord, GroupChat, Message, Post } from '@maidan/shared';

import { API_BASE_URL } from './apiClient';
import { getAuthTokens } from './authTokens';

export type CompactMessage = Pick<Message, 'id' | 'chat_id' | 'sender_id' | 'body' | 'created_at'>;
export type DomainEventEnvelope = Pick<
  DomainEventRecord,
  'id' | 'aggregate_type' | 'aggregate_id' | 'event_type' | 'payload' | 'created_at'
>;

export interface BookingConfirmedEvent {
  booking: Partial<Booking>;
  chat: GroupChat;
}

export interface ChatJoinedEvent {
  chat: GroupChat;
  memberIds: string[];
}

export interface ChatMemberRemovedEvent {
  chatId: string;
  profileId: string;
}

export interface PresenceEvent {
  chatId?: string;
  profileId: string;
  status: 'online' | 'offline';
}

export interface TypingEvent {
  chatId: string;
  profileId: string;
  isTyping: boolean;
}

export interface BasicAck {
  ok: boolean;
  error?: string;
}

export interface JoinAck extends BasicAck {
  chatId?: string;
}

export interface MessageSendAck extends BasicAck {
  message?: CompactMessage;
}

interface ClientToServerEvents {
  join: (payload: { chatId: string }, ack?: (response: JoinAck) => void) => void;
  'message:send': (
    payload: { chatId: string; body: string },
    ack?: (response: MessageSendAck) => void
  ) => void;
  typing: (
    payload: { chatId: string; isTyping?: boolean },
    ack?: (response: BasicAck) => void
  ) => void;
}

interface ServerToClientEvents {
  'booking:confirmed': (payload: BookingConfirmedEvent) => void;
  'chat:joined': (payload: ChatJoinedEvent) => void;
  'chat:member_removed': (payload: ChatMemberRemovedEvent) => void;
  'domain:event': (event: DomainEventEnvelope) => void;
  'feed:new': (payload: Post) => void;
  'message:new': (message: CompactMessage) => void;
  presence: (payload: PresenceEvent) => void;
  'realtime:error': (payload: { message: string }) => void;
  typing: (payload: TypingEvent) => void;
}

export type RealtimeStatus = 'idle' | 'unauthenticated' | 'connecting' | 'connected' | 'error';

type UntypedEventHandler = (...args: unknown[]) => void;

interface UntypedEventSocket {
  on(event: string, handler: UntypedEventHandler): void;
  off(event: string, handler: UntypedEventHandler): void;
}

export class RealtimeClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private status: RealtimeStatus = 'idle';
  private readonly eventListeners = new Map<string, Set<UntypedEventHandler>>();
  private readonly statusListeners = new Set<(status: RealtimeStatus) => void>();

  getStatus(): RealtimeStatus {
    return this.status;
  }

  subscribeStatus(listener: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);

    return () => {
      this.statusListeners.delete(listener);
    };
  }

  connect(): void {
    const tokens = getAuthTokens();

    if (tokens === null) {
      this.disconnect();
      this.setStatus('unauthenticated');
      return;
    }

    if (this.socket?.connected === true) {
      this.setStatus('connected');
      return;
    }

    this.disconnect();
    this.setStatus('connecting');
    this.socket = io(API_BASE_URL, {
      auth: {
        token: tokens.accessToken
      },
      transports: ['websocket', 'polling']
    });
    this.socket.on('connect', () => this.setStatus('connected'));
    this.socket.on('connect_error', () => this.setStatus('error'));
    this.socket.on('disconnect', () => this.setStatus('idle'));
    this.socket.on('realtime:error', () => this.setStatus('error'));
    this.attachStoredEventListeners(this.socket);
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  on<KEvent extends keyof ServerToClientEvents>(
    event: KEvent,
    handler: ServerToClientEvents[KEvent]
  ): () => void {
    const eventName = String(event);
    const socket = this.socket as UntypedEventSocket | null;
    const untypedHandler = handler as UntypedEventHandler;

    this.eventListeners.set(
      eventName,
      (this.eventListeners.get(eventName) ?? new Set<UntypedEventHandler>()).add(untypedHandler)
    );

    if (socket !== null) {
      socket.on(eventName, untypedHandler);
    }

    return () => {
      this.eventListeners.get(eventName)?.delete(untypedHandler);
      socket?.off(eventName, untypedHandler);
    };
  }

  joinChat(chatId: string): Promise<JoinAck> {
    if (this.socket === null) {
      return Promise.resolve({ ok: false, error: 'Realtime socket is not connected' });
    }

    return this.emitWithAck(
      (ack) => this.socket?.emit('join', { chatId }, ack),
      'Chat room join was not acknowledged',
      3
    );
  }

  leaveChat(chatId: string): void {
    this.socket?.emit('typing', { chatId, isTyping: false });
  }

  sendMessage(chatId: string, body: string): Promise<MessageSendAck> {
    if (this.socket === null) {
      return Promise.resolve({ ok: false, error: 'Realtime socket is not connected' });
    }

    return this.emitWithAck(
      (ack) => this.socket?.emit('message:send', { chatId, body }, ack),
      'Message send was not acknowledged',
      1
    );
  }

  sendTyping(chatId: string, isTyping = true): Promise<BasicAck> {
    if (this.socket === null) {
      return Promise.resolve({ ok: false, error: 'Realtime socket is not connected' });
    }

    return this.emitWithAck(
      (ack) => this.socket?.emit('typing', { chatId, isTyping }, ack),
      'Typing update was not acknowledged',
      1
    );
  }

  private setStatus(status: RealtimeStatus): void {
    this.status = status;

    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private attachStoredEventListeners(
    socket: Socket<ServerToClientEvents, ClientToServerEvents>
  ): void {
    const untypedSocket = socket as unknown as UntypedEventSocket;

    for (const [event, handlers] of this.eventListeners.entries()) {
      for (const handler of handlers) {
        untypedSocket.on(event, handler);
      }
    }
  }

  private emitWithAck<TAck extends BasicAck>(
    emit: (ack: (response: TAck) => void) => void,
    timeoutError: string,
    maxAttempts: number
  ): Promise<TAck> {
    return new Promise((resolve) => {
      let attempts = 0;
      let settled = false;
      let timer: number | null = null;

      const finish = (response: TAck): void => {
        if (settled) {
          return;
        }

        settled = true;

        if (timer !== null) {
          window.clearTimeout(timer);
        }

        resolve(response);
      };

      const attempt = (): void => {
        attempts += 1;
        emit(finish);
        timer = window.setTimeout(() => {
          if (settled) {
            return;
          }

          if (attempts >= maxAttempts) {
            finish({ ok: false, error: timeoutError } as TAck);
            return;
          }

          attempt();
        }, 800);
      };

      attempt();
    });
  }
}

export const realtimeClient = new RealtimeClient();
