import type { ActivityPillar, ActivityStatus, BookingConfirmedPayload } from '@maidan/shared';

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

export interface ChatActivitySummary {
  id: string;
  title: string;
  pillar: ActivityPillar;
  status: ActivityStatus;
}

export interface ChatListItem {
  chat: GroupChatRecord;
  activity: ChatActivitySummary;
  role: 'host' | 'member';
  can_manage: boolean;
}

export interface ChatMemberRecord {
  profile_id: string;
  display_name: string;
  avatar_url: string | null;
  joined_at: string;
  role: 'host' | 'member';
}

export interface RemoveChatMemberResponse {
  chat_id: string;
  profile_id: string;
  removed: true;
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
  findChatsForProfile(profileId: string): Promise<ChatListItem[]>;
  findChat(profileId: string, chatId: string): Promise<ChatListItem | undefined>;
  findActivityChat(profileId: string, activityId: string): Promise<ChatListItem | undefined>;
  findChatMembers(profileId: string, chatId: string): Promise<ChatMemberRecord[] | undefined>;
  findChatIdsForMember(profileId: string): Promise<string[]>;
  isChatMember(chatId: string, profileId: string): Promise<boolean>;
  createMessage(senderId: string, input: CreateMessageInput): Promise<MessageRecord | undefined>;
  findMessages(profileId: string, chatId: string, input: MessagesPageInput): Promise<MessageRecord[] | undefined>;
  removeChatMember(chatId: string, profileId: string): Promise<RemoveChatMemberResponse | undefined>;
}
