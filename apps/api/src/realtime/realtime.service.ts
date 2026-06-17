import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Buffer } from 'node:buffer';

import type { BookingConfirmedPayload } from '@maidan/shared';
import { DEFAULT_MESSAGES_LIMIT, REALTIME_REPOSITORY } from './realtime.constants';
import type { MessagesPageQueryDto } from './dto/messages-page-query.dto';
import type {
  BookingChatRecord,
  MessageRecord,
  MessagesCursor,
  MessagesPageInput,
  PaginatedMessagesResponse,
  RealtimeRepository
} from './realtime.types';

@Injectable()
export class RealtimeService {
  constructor(@Inject(REALTIME_REPOSITORY) private readonly repository: RealtimeRepository) {}

  async ensureBookingChat(
    payload: BookingConfirmedPayload
  ): Promise<BookingChatRecord | undefined> {
    return this.repository.ensureBookingChat(payload);
  }

  async getChatIdsForMember(profileId: string): Promise<string[]> {
    return this.repository.findChatIdsForMember(profileId);
  }

  async assertChatMember(chatId: string, profileId: string): Promise<void> {
    if (!(await this.repository.isChatMember(chatId, profileId))) {
      throw new NotFoundException('Chat not found');
    }
  }

  async createMessage(
    senderId: string,
    input: { chatId: string; body: string }
  ): Promise<MessageRecord> {
    const body = input.body.trim();

    if (body.length === 0) {
      throw new BadRequestException('Message body is required');
    }

    const message = await this.repository.createMessage(senderId, {
      chat_id: input.chatId,
      body
    });

    if (message === undefined) {
      throw new NotFoundException('Chat not found');
    }

    return message;
  }

  async findMessages(
    profileId: string,
    chatId: string,
    dto: MessagesPageQueryDto
  ): Promise<PaginatedMessagesResponse> {
    const input = toMessagesPageInput(dto);
    const messages = await this.repository.findMessages(profileId, chatId, {
      ...input,
      limit: input.limit + 1
    });

    if (messages === undefined) {
      throw new NotFoundException('Chat not found');
    }

    return toPaginatedMessagesResponse(messages, input.limit);
  }
}

function toMessagesPageInput(dto: MessagesPageQueryDto): MessagesPageInput {
  return {
    limit: dto.limit ?? DEFAULT_MESSAGES_LIMIT,
    cursor: dto.cursor === undefined ? undefined : decodeCursor(dto.cursor)
  };
}

function toPaginatedMessagesResponse(
  messages: MessageRecord[],
  limit: number
): PaginatedMessagesResponse {
  const items = messages.slice(0, limit);
  const lastItem = items.at(-1);

  return {
    items,
    next_cursor: messages.length > limit && lastItem !== undefined ? encodeCursor(lastItem) : null
  };
}

function encodeCursor(message: MessageRecord): string {
  const cursor: MessagesCursor = {
    created_at: message.created_at,
    id: message.id
  };

  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): MessagesCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;

    if (!isCursor(value)) {
      throw new Error('Invalid cursor shape');
    }

    return value;
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

function isCursor(value: unknown): value is MessagesCursor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<MessagesCursor>;

  return (
    typeof candidate.created_at === 'string' &&
    !Number.isNaN(new Date(candidate.created_at).getTime()) &&
    typeof candidate.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate.id
    )
  );
}
