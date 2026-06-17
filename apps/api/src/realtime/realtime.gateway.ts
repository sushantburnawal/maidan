import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  UnauthorizedException
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import { Server, type Socket } from 'socket.io';

import { bookingConfirmedPayloadSchema } from '@maidan/shared';
import { AuthService } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { DomainEventEnvelope } from '../outbox/outbox.types';
import { RedisInfrastructure } from '../redis/redis.infrastructure';
import { RealtimeService } from './realtime.service';
import type { BookingChatRecord, MessageRecord } from './realtime.types';

type Ack<T> = (response: T) => void;

interface ClientToServerEvents {
  join: (payload: unknown, ack?: Ack<JoinAck>) => void;
  'message:send': (payload: unknown, ack?: Ack<MessageSendAck>) => void;
  typing: (payload: unknown, ack?: Ack<BasicAck>) => void;
}

interface ServerToClientEvents {
  'booking:confirmed': (payload: BookingConfirmedSocketEvent) => void;
  'chat:joined': (payload: ChatJoinedSocketEvent) => void;
  'domain:event': (event: DomainEventEnvelope) => void;
  'feed:new': (payload: Record<string, unknown>) => void;
  'message:new': (message: MessageRecord) => void;
  presence: (payload: PresenceSocketEvent) => void;
  'realtime:error': (payload: { message: string }) => void;
  typing: (payload: TypingSocketEvent) => void;
}

interface SocketData {
  profileId: string;
  joinedChatIds: Set<string>;
}

interface BasicAck {
  ok: boolean;
  error?: string;
}

interface JoinAck extends BasicAck {
  chatId?: string;
}

interface MessageSendAck extends BasicAck {
  message?: MessageRecord;
}

interface SendMessagePayload {
  chatId: string;
  body: string;
}

interface JoinPayload {
  chatId: string;
}

interface TypingPayload {
  chatId: string;
  isTyping?: boolean;
}

interface BookingConfirmedSocketEvent {
  booking: Record<string, unknown>;
  chat: BookingChatRecord['chat'];
}

interface ChatJoinedSocketEvent {
  chat: BookingChatRecord['chat'];
  memberIds: string[];
}

interface PresenceSocketEvent {
  chatId?: string;
  profileId: string;
  status: 'online' | 'offline';
}

interface TypingSocketEvent {
  chatId: string;
  profileId: string;
  isTyping: boolean;
}

type RealtimeSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly onlineCounts = new Map<string, number>();
  private server: Server<ClientToServerEvents, ServerToClientEvents, never, SocketData> | undefined;
  private redisPubClient: Redis | undefined;
  private redisSubClient: Redis | undefined;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly authService: AuthService,
    private readonly realtimeService: RealtimeService,
    private readonly redisInfrastructure: RedisInfrastructure
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();
    const io = new Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>(
      httpServer,
      {
        cors: {
          origin: getAllowedOrigins(),
          credentials: true
        },
        path: process.env.SOCKET_IO_PATH ?? '/socket.io'
      }
    );

    this.configureRedisAdapter(io);

    io.use((socket, next) => {
      try {
        const user = this.authenticateSocket(socket);
        socket.data.profileId = user.profileId;
        socket.data.joinedChatIds = new Set<string>();
        next();
      } catch (error) {
        next(error instanceof Error ? error : new UnauthorizedException('Invalid access token'));
      }
    });
    io.on('connection', (socket) => {
      void this.handleConnection(socket);
    });

    this.server = io;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.server !== undefined) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
    }

    await Promise.all([closeRedisClient(this.redisPubClient), closeRedisClient(this.redisSubClient)]);
  }

  async publishDomainEvent(event: DomainEventEnvelope): Promise<void> {
    const io = this.getServer();

    if (event.event_type === 'booking.confirmed') {
      const parsed = bookingConfirmedPayloadSchema.safeParse(event.payload);

      if (parsed.success) {
        const bookingChat = await this.realtimeService.ensureBookingChat(parsed.data);

        if (bookingChat !== undefined) {
          await this.attachMembersToChatRoom(bookingChat);
          this.emitBookingConfirmed(bookingChat, event.payload);
        }
      } else {
        this.logger.warn(`Ignored booking.confirmed with invalid payload event=${event.id}`);
      }
    }

    const profileIds = extractTargetProfileIds(event.payload);

    for (const profileId of profileIds) {
      io.to(userRoom(profileId)).emit('domain:event', event);
    }

    if (event.event_type === 'post.created') {
      io.emit('feed:new', event.payload);
    }
  }

  private configureRedisAdapter(
    io: Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>
  ): void {
    if (isRedisAdapterDisabled()) {
      return;
    }

    const pubClient = this.redisInfrastructure.client.duplicate();
    const subClient = this.redisInfrastructure.client.duplicate();

    pubClient.on('error', (error) => {
      this.logger.error(
        'Socket.io Redis adapter publisher error',
        error instanceof Error ? error.stack : String(error)
      );
    });
    subClient.on('error', (error) => {
      this.logger.error(
        'Socket.io Redis adapter subscriber error',
        error instanceof Error ? error.stack : String(error)
      );
    });

    io.adapter(createAdapter(pubClient, subClient));
    this.redisPubClient = pubClient;
    this.redisSubClient = subClient;
  }

  private authenticateSocket(socket: RealtimeSocket): AuthenticatedUser {
    const token = extractSocketBearerToken(socket);

    return this.authService.authenticateAccessToken(token);
  }

  private async handleConnection(socket: RealtimeSocket): Promise<void> {
    const profileId = socket.data.profileId;
    const becameOnline = this.incrementPresence(profileId);

    try {
      await socket.join(userRoom(profileId));

      const chatIds = await this.realtimeService.getChatIdsForMember(profileId);

      for (const chatId of chatIds) {
        await socket.join(chatRoom(chatId));
        socket.data.joinedChatIds.add(chatId);
      }

      this.registerSocketHandlers(socket);

      if (becameOnline) {
        this.emitPresence(socket, 'online');
      }
    } catch (error) {
      this.decrementPresence(profileId);
      socket.emit('realtime:error', { message: toClientErrorMessage(error) });
      socket.disconnect(true);
    }
  }

  private registerSocketHandlers(socket: RealtimeSocket): void {
    socket.on('join', (payload, ack) => {
      void this.handleJoin(socket, payload, ack);
    });
    socket.on('message:send', (payload, ack) => {
      void this.handleMessageSend(socket, payload, ack);
    });
    socket.on('typing', (payload, ack) => {
      void this.handleTyping(socket, payload, ack);
    });
    socket.on('disconnect', () => {
      this.handleDisconnect(socket);
    });
  }

  private async handleJoin(
    socket: RealtimeSocket,
    payload: unknown,
    ack: Ack<JoinAck> | undefined
  ): Promise<void> {
    try {
      const parsed = parseJoinPayload(payload);

      await this.realtimeService.assertChatMember(parsed.chatId, socket.data.profileId);
      await socket.join(chatRoom(parsed.chatId));
      socket.data.joinedChatIds.add(parsed.chatId);
      socket.to(chatRoom(parsed.chatId)).emit('presence', {
        chatId: parsed.chatId,
        profileId: socket.data.profileId,
        status: 'online'
      });
      ack?.({ ok: true, chatId: parsed.chatId });
    } catch (error) {
      ack?.({ ok: false, error: toClientErrorMessage(error) });
    }
  }

  private async handleMessageSend(
    socket: RealtimeSocket,
    payload: unknown,
    ack: Ack<MessageSendAck> | undefined
  ): Promise<void> {
    try {
      const parsed = parseSendMessagePayload(payload);
      const message = await this.realtimeService.createMessage(socket.data.profileId, parsed);

      await socket.join(chatRoom(message.chat_id));
      socket.data.joinedChatIds.add(message.chat_id);
      this.getServer().to(chatRoom(message.chat_id)).emit('message:new', message);
      ack?.({ ok: true, message });
    } catch (error) {
      ack?.({ ok: false, error: toClientErrorMessage(error) });
    }
  }

  private async handleTyping(
    socket: RealtimeSocket,
    payload: unknown,
    ack: Ack<BasicAck> | undefined
  ): Promise<void> {
    try {
      const parsed = parseTypingPayload(payload);

      await this.realtimeService.assertChatMember(parsed.chatId, socket.data.profileId);
      socket.to(chatRoom(parsed.chatId)).emit('typing', {
        chatId: parsed.chatId,
        profileId: socket.data.profileId,
        isTyping: parsed.isTyping ?? true
      });
      ack?.({ ok: true });
    } catch (error) {
      ack?.({ ok: false, error: toClientErrorMessage(error) });
    }
  }

  private handleDisconnect(socket: RealtimeSocket): void {
    const profileId = socket.data.profileId;

    if (this.decrementPresence(profileId)) {
      this.emitPresence(socket, 'offline');
    }
  }

  private async attachMembersToChatRoom(bookingChat: BookingChatRecord): Promise<void> {
    const io = this.getServer();

    for (const memberId of bookingChat.member_ids) {
      io.in(userRoom(memberId)).socketsJoin(chatRoom(bookingChat.chat.id));
    }
  }

  private emitBookingConfirmed(
    bookingChat: BookingChatRecord,
    bookingPayload: Record<string, unknown>
  ): void {
    const io = this.getServer();
    const chatJoinedPayload: ChatJoinedSocketEvent = {
      chat: bookingChat.chat,
      memberIds: bookingChat.member_ids
    };
    const bookingConfirmedPayload: BookingConfirmedSocketEvent = {
      booking: bookingPayload,
      chat: bookingChat.chat
    };

    for (const memberId of bookingChat.member_ids) {
      const room = userRoom(memberId);

      io.to(room).emit('chat:joined', chatJoinedPayload);
      io.to(room).emit('booking:confirmed', bookingConfirmedPayload);
    }
  }

  private emitPresence(socket: RealtimeSocket, status: 'online' | 'offline'): void {
    for (const chatId of socket.data.joinedChatIds) {
      socket.to(chatRoom(chatId)).emit('presence', {
        chatId,
        profileId: socket.data.profileId,
        status
      });
    }

    socket.emit('presence', {
      profileId: socket.data.profileId,
      status
    });
  }

  private incrementPresence(profileId: string): boolean {
    const currentCount = this.onlineCounts.get(profileId) ?? 0;

    this.onlineCounts.set(profileId, currentCount + 1);

    return currentCount === 0;
  }

  private decrementPresence(profileId: string): boolean {
    const currentCount = this.onlineCounts.get(profileId) ?? 0;

    if (currentCount <= 1) {
      this.onlineCounts.delete(profileId);
      return true;
    }

    this.onlineCounts.set(profileId, currentCount - 1);

    return false;
  }

  private getServer(): Server<ClientToServerEvents, ServerToClientEvents, never, SocketData> {
    if (this.server === undefined) {
      throw new Error('Realtime gateway has not been initialized');
    }

    return this.server;
  }
}

function extractSocketBearerToken(socket: RealtimeSocket): string {
  const authToken = socket.handshake.auth.token;

  if (typeof authToken === 'string' && authToken.length > 0) {
    return stripBearerPrefix(authToken);
  }

  const authorization = socket.handshake.headers.authorization;
  const header = Array.isArray(authorization) ? authorization[0] : authorization;

  if (header !== undefined) {
    return stripBearerPrefix(header);
  }

  const queryToken = socket.handshake.query.token;

  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return stripBearerPrefix(queryToken);
  }

  throw new UnauthorizedException('Missing bearer token');
}

function stripBearerPrefix(value: string): string {
  const [scheme, token] = value.split(' ');

  if (scheme === 'Bearer' && token !== undefined && token.length > 0) {
    return token;
  }

  if (!value.includes(' ')) {
    return value;
  }

  throw new UnauthorizedException('Invalid bearer token');
}

function parseJoinPayload(payload: unknown): JoinPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Invalid join payload');
  }

  const candidate = payload as Partial<JoinPayload>;

  if (!isUuid(candidate.chatId)) {
    throw new Error('Invalid chat id');
  }

  return {
    chatId: candidate.chatId
  };
}

function parseSendMessagePayload(payload: unknown): SendMessagePayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Invalid message payload');
  }

  const candidate = payload as Partial<SendMessagePayload>;

  if (!isUuid(candidate.chatId)) {
    throw new Error('Invalid chat id');
  }

  if (typeof candidate.body !== 'string') {
    throw new Error('Message body is required');
  }

  return {
    chatId: candidate.chatId,
    body: candidate.body
  };
}

function parseTypingPayload(payload: unknown): TypingPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Invalid typing payload');
  }

  const candidate = payload as Partial<TypingPayload>;

  if (!isUuid(candidate.chatId)) {
    throw new Error('Invalid chat id');
  }

  if (candidate.isTyping !== undefined && typeof candidate.isTyping !== 'boolean') {
    throw new Error('Invalid typing state');
  }

  return {
    chatId: candidate.chatId,
    isTyping: candidate.isTyping
  };
}

function extractTargetProfileIds(payload: Record<string, unknown>): string[] {
  const candidateKeys = ['explorer_id', 'host_id', 'author_id', 'sender_id'];
  const profileIds: string[] = [];

  for (const key of candidateKeys) {
    const value = payload[key];

    if (typeof value === 'string' && isUuid(value)) {
      profileIds.push(value);
    }
  }

  return Array.from(new Set(profileIds));
}

function userRoom(profileId: string): string {
  return `user:${profileId}`;
}

function chatRoom(chatId: string): string {
  return `chat:${chatId}`;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function toClientErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return 'Realtime request failed';
}

async function closeRedisClient(client: Redis | undefined): Promise<void> {
  if (client === undefined || client.status === 'end') {
    return;
  }

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

function getAllowedOrigins(): string[] | boolean {
  const rawOrigins = process.env.CORS_ORIGIN;

  if (rawOrigins === undefined || rawOrigins.length === 0) {
    return true;
  }

  return rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function isRedisAdapterDisabled(): boolean {
  if (process.env.REALTIME_REDIS_ADAPTER_DISABLED === 'true') {
    return true;
  }

  return (
    process.env.NODE_ENV === 'test' && process.env.REALTIME_REDIS_ADAPTER_DISABLED !== 'false'
  );
}
