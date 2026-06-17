import type { BookingConfirmedPayload } from '@maidan/shared';

export interface GroupChatRecord {
  id: string;
  activity_id: string;
  title: string;
  created_at: string;
}

export interface BookingChatRecord {
  chat: GroupChatRecord;
  member_ids: string[];
}

export interface MessageRecord {
  id: string;
  chat_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

export interface CreateMessageInput {
  chat_id: string;
  body: string;
}

export interface MessagesCursor {
  created_at: string;
  id: string;
}

export interface MessagesPageInput {
  limit: number;
  cursor?: MessagesCursor;
}

export interface PaginatedMessagesResponse {
  items: MessageRecord[];
  next_cursor: string | null;
}

export interface RealtimeRepository {
  ensureBookingChat(payload: BookingConfirmedPayload): Promise<BookingChatRecord | undefined>;
  findChatIdsForMember(profileId: string): Promise<string[]>;
  isChatMember(chatId: string, profileId: string): Promise<boolean>;
  createMessage(senderId: string, input: CreateMessageInput): Promise<MessageRecord | undefined>;
  findMessages(profileId: string, chatId: string, input: MessagesPageInput): Promise<MessageRecord[] | undefined>;
}
