import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket as ClientSocket } from 'socket.io-client';

import type { BookingConfirmedPayload } from '@maidan/shared';
import { AuthService } from '../src/auth/auth.service';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { REALTIME_REPOSITORY } from '../src/realtime/realtime.constants';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import { RealtimeModule } from '../src/realtime/realtime.module';
import type {
  BookingChatRecord,
  CreateMessageInput,
  GroupChatRecord,
  MessageRecord,
  MessagesPageInput,
  RealtimeRepository
} from '../src/realtime/realtime.types';

class FakeAuthService {
  constructor(private readonly profileIdsByToken: ReadonlyMap<string, string>) {}

  authenticateAccessToken(accessToken: string): AuthenticatedUser {
    const profileId = this.profileIdsByToken.get(accessToken);

    if (profileId === undefined) {
      throw new UnauthorizedException('Invalid access token');
    }

    return { profileId };
  }
}

interface FakeActivity {
  id: string;
  host_id: string;
  title: string;
}

interface FakeDomainEvent {
  aggregate_type: 'message';
  aggregate_id: string;
  event_type: 'message.created';
  payload: Record<string, unknown>;
}

class FakeRealtimeRepository implements RealtimeRepository {
  private readonly activities = new Map<string, FakeActivity>();
  private readonly chatIdsByActivity = new Map<string, string>();
  private readonly chats = new Map<string, GroupChatRecord>();
  private readonly members = new Map<string, Set<string>>();
  private readonly messages: MessageRecord[] = [];
  private readonly domainEvents: FakeDomainEvent[] = [];
  private messageSequence = 0;

  reset(): void {
    this.activities.clear();
    this.chatIdsByActivity.clear();
    this.chats.clear();
    this.members.clear();
    this.messages.length = 0;
    this.domainEvents.length = 0;
    this.messageSequence = 0;
  }

  addActivity(input: { host_id: string; title: string }): string {
    const id = randomUUID();

    this.activities.set(id, {
      id,
      host_id: input.host_id,
      title: input.title
    });

    return id;
  }

  memberIdsFor(chatId: string): string[] {
    return Array.from(this.members.get(chatId) ?? []);
  }

  allMessages(): MessageRecord[] {
    return this.messages.map(cloneMessage);
  }

  allDomainEvents(): FakeDomainEvent[] {
    return this.domainEvents.map((event) => ({
      ...event,
      payload: { ...event.payload }
    }));
  }

  async ensureBookingChat(
    payload: BookingConfirmedPayload
  ): Promise<BookingChatRecord | undefined> {
    const activity = this.activities.get(payload.activity_id);

    if (activity === undefined) {
      return undefined;
    }

    const chat = this.findOrCreateChat(activity);
    const memberIds = Array.from(new Set([payload.explorer_id, payload.host_id]));
    const members = this.members.get(chat.id) ?? new Set<string>();

    for (const memberId of memberIds) {
      members.add(memberId);
    }

    this.members.set(chat.id, members);

    return {
      chat: cloneChat(chat),
      member_ids: memberIds
    };
  }

  async findChatIdsForMember(profileId: string): Promise<string[]> {
    return Array.from(this.members.entries())
      .filter(([, memberIds]) => memberIds.has(profileId))
      .map(([chatId]) => chatId);
  }

  async isChatMember(chatId: string, profileId: string): Promise<boolean> {
    return this.members.get(chatId)?.has(profileId) === true;
  }

  async createMessage(
    senderId: string,
    input: CreateMessageInput
  ): Promise<MessageRecord | undefined> {
    if (!(await this.isChatMember(input.chat_id, senderId))) {
      return undefined;
    }

    const chat = this.chats.get(input.chat_id);

    if (chat === undefined) {
      return undefined;
    }

    this.messageSequence += 1;

    const message: MessageRecord = {
      id: randomUUID(),
      chat_id: input.chat_id,
      sender_id: senderId,
      body: input.body,
      created_at: new Date(
        Date.parse('2026-06-17T08:30:00.000Z') + this.messageSequence
      ).toISOString()
    };

    this.messages.push(cloneMessage(message));
    this.domainEvents.push({
      aggregate_type: 'message',
      aggregate_id: message.id,
      event_type: 'message.created',
      payload: {
        message_id: message.id,
        chat_id: message.chat_id,
        sender_id: message.sender_id,
        activity_id: chat.activity_id,
        body: message.body,
        created_at: message.created_at
      }
    });

    return cloneMessage(message);
  }

  async findMessages(
    profileId: string,
    chatId: string,
    input: MessagesPageInput
  ): Promise<MessageRecord[] | undefined> {
    if (!(await this.isChatMember(chatId, profileId))) {
      return undefined;
    }

    let messages = this.messages
      .filter((message) => message.chat_id === chatId)
      .sort(compareMessagesDesc);

    if (input.cursor !== undefined) {
      messages = messages.filter(
        (message) =>
          message.created_at < input.cursor!.created_at ||
          (message.created_at === input.cursor!.created_at && message.id < input.cursor!.id)
      );
    }

    return messages.slice(0, input.limit).map(cloneMessage);
  }

  private findOrCreateChat(activity: FakeActivity): GroupChatRecord {
    const existingChatId = this.chatIdsByActivity.get(activity.id);

    if (existingChatId !== undefined) {
      const existingChat = this.chats.get(existingChatId);

      if (existingChat !== undefined) {
        return existingChat;
      }
    }

    const chat: GroupChatRecord = {
      id: randomUUID(),
      activity_id: activity.id,
      title: activity.title,
      created_at: '2026-06-17T08:00:00.000Z'
    };

    this.chatIdsByActivity.set(activity.id, chat.id);
    this.chats.set(chat.id, chat);
    this.members.set(chat.id, new Set<string>());

    return chat;
  }
}

interface ChatJoinedPayload {
  chat: GroupChatRecord;
  memberIds: string[];
}

interface MessageSendAck {
  ok: boolean;
  error?: string;
  message?: MessageRecord;
}

describe('Realtime module', () => {
  let app: NestFastifyApplication;
  let gateway: RealtimeGateway;
  let repository: FakeRealtimeRepository;
  let serverUrl: string;
  let sockets: ClientSocket[] = [];

  const hostProfileId = randomUUID();
  const explorerProfileId = randomUUID();
  const hostToken = 'host-token';
  const explorerToken = 'explorer-token';
  const previousRealtimeRedisAdapterDisabled = process.env.REALTIME_REDIS_ADAPTER_DISABLED;
  const previousRealtimeStreamConsumerDisabled = process.env.REALTIME_STREAM_CONSUMER_DISABLED;

  beforeAll(async () => {
    process.env.REALTIME_REDIS_ADAPTER_DISABLED = 'true';
    process.env.REALTIME_STREAM_CONSUMER_DISABLED = 'true';

    repository = new FakeRealtimeRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [RealtimeModule]
    })
      .overrideProvider(AuthService)
      .useValue(
        new FakeAuthService(
          new Map([
            [hostToken, hostProfileId],
            [explorerToken, explorerProfileId]
          ])
        )
      )
      .overrideProvider(REALTIME_REPOSITORY)
      .useValue(repository)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true
      })
    );

    await app.listen(0, '127.0.0.1');
    await app.getHttpAdapter().getInstance().ready();

    gateway = app.get(RealtimeGateway);
    serverUrl = getServerUrl(app);
  });

  beforeEach(() => {
    repository.reset();
    sockets = [];
  });

  afterEach(() => {
    for (const socket of sockets) {
      socket.disconnect();
    }
  });

  afterAll(async () => {
    restoreEnv('REALTIME_REDIS_ADAPTER_DISABLED', previousRealtimeRedisAdapterDisabled);
    restoreEnv('REALTIME_STREAM_CONSUMER_DISABLED', previousRealtimeStreamConsumerDisabled);
    await app.close();
  });

  it('puts host and explorer in the activity chat after booking confirmation and persists messages', async () => {
    const activityId = repository.addActivity({
      host_id: hostProfileId,
      title: "Hemant's Nandi Hills sunrise trail ride"
    });
    const hostSocket = await connectSocket(serverUrl, hostToken, sockets);
    const explorerSocket = await connectSocket(serverUrl, explorerToken, sockets);
    const hostJoinedPromise = onceSocketEvent<ChatJoinedPayload>(hostSocket, 'chat:joined');
    const explorerJoinedPromise = onceSocketEvent<ChatJoinedPayload>(explorerSocket, 'chat:joined');
    const bookingPayload: BookingConfirmedPayload = {
      booking_id: randomUUID(),
      slot_id: randomUUID(),
      activity_id: activityId,
      explorer_id: explorerProfileId,
      host_id: hostProfileId,
      payment_id: randomUUID(),
      headcount: 1,
      amount_inr: 1499,
      confirmed_at: '2026-06-17T08:05:00.000Z'
    };

    await gateway.publishDomainEvent({
      id: 1,
      aggregate_type: 'booking',
      aggregate_id: bookingPayload.booking_id,
      event_type: 'booking.confirmed',
      payload: bookingPayload,
      created_at: bookingPayload.confirmed_at
    });

    const [hostJoined, explorerJoined] = await Promise.all([
      hostJoinedPromise,
      explorerJoinedPromise
    ]);
    const chatId = hostJoined.chat.id;

    expect(explorerJoined.chat.id).toBe(chatId);
    expect(repository.memberIdsFor(chatId).sort()).toEqual(
      [explorerProfileId, hostProfileId].sort()
    );

    const hostMessagePromise = onceSocketEvent<MessageRecord>(hostSocket, 'message:new');
    const explorerMessagePromise = onceSocketEvent<MessageRecord>(explorerSocket, 'message:new');
    const ack = await emitWithAck<MessageSendAck>(explorerSocket, 'message:send', {
      chatId,
      body: 'See you at the trailhead.'
    });

    expect(ack).toMatchObject({
      ok: true,
      message: {
        chat_id: chatId,
        sender_id: explorerProfileId,
        body: 'See you at the trailhead.'
      }
    });

    const [hostMessage, explorerMessage] = await Promise.all([
      hostMessagePromise,
      explorerMessagePromise
    ]);

    expect(hostMessage).toEqual(explorerMessage);
    expect(repository.allMessages()).toEqual([
      expect.objectContaining({
        id: hostMessage.id,
        chat_id: chatId,
        sender_id: explorerProfileId,
        body: 'See you at the trailhead.'
      })
    ]);
    expect(repository.allDomainEvents()).toEqual([
      expect.objectContaining({
        aggregate_type: 'message',
        aggregate_id: hostMessage.id,
        event_type: 'message.created',
        payload: expect.objectContaining({
          message_id: hostMessage.id,
          chat_id: chatId,
          sender_id: explorerProfileId,
          activity_id: activityId,
          body: 'See you at the trailhead.'
        })
      })
    ]);

    const historyResponse = await app.inject({
      method: 'GET',
      url: `/chats/${chatId}/messages`,
      headers: {
        authorization: `Bearer ${hostToken}`
      }
    });

    expect(historyResponse.statusCode).toBe(200);
    expect(historyResponse.json()).toMatchObject({
      items: [
        {
          id: hostMessage.id,
          chat_id: chatId,
          sender_id: explorerProfileId,
          body: 'See you at the trailhead.'
        }
      ],
      next_cursor: null
    });
  });
});

async function connectSocket(
  url: string,
  token: string,
  sockets: ClientSocket[]
): Promise<ClientSocket> {
  const socket = io(url, {
    auth: {
      token
    },
    forceNew: true,
    reconnection: false,
    transports: ['websocket']
  });

  sockets.push(socket);
  await onceSocketEvent(socket, 'connect');

  return socket;
}

function onceSocketEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for socket event ${event}`));
    }, 1500);
    const onEvent = (payload: T) => {
      cleanup();
      resolve(payload);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(event, onEvent);
      socket.off('connect_error', onError);
    };

    socket.once(event, onEvent);
    socket.once('connect_error', onError);
  });
}

function emitWithAck<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for socket ack ${event}`));
    }, 1500);

    socket.emit(event, payload, (response: T) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

function getServerUrl(app: NestFastifyApplication): string {
  const address = app.getHttpServer().address() as AddressInfo | string | null;

  if (address === null || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on a TCP port');
  }

  return `http://127.0.0.1:${address.port}`;
}

function compareMessagesDesc(left: MessageRecord, right: MessageRecord): number {
  if (left.created_at !== right.created_at) {
    return right.created_at.localeCompare(left.created_at);
  }

  return right.id.localeCompare(left.id);
}

function cloneChat(chat: GroupChatRecord): GroupChatRecord {
  return { ...chat };
}

function cloneMessage(message: MessageRecord): MessageRecord {
  return { ...message };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
