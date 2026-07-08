import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

import type { BookingConfirmedPayload, MessageCreatedPayload } from '@maidan/shared';
import { withCurrentCorrelation } from '../observability/request-context';
import type {
  BookingChatRecord,
  ChatListItem,
  ChatMemberRecord,
  CreateMessageInput,
  GroupChatRecord,
  MessageRecord,
  MessagesPageInput,
  RealtimeRepository,
  RemoveChatMemberResponse
} from './realtime.types';

interface GroupChatRow {
  id: string;
  activity_id: string;
  title: string;
  created_at: Date | string;
}

interface ChatListRow extends GroupChatRow {
  activity_title: string;
  activity_pillar: 'move' | 'learn' | 'feel';
  activity_status: 'draft' | 'published' | 'paused' | 'archived';
  actor_is_host: boolean;
}

interface ChatMemberRow {
  profile_id: string;
  display_name: string;
  avatar_url: string | null;
  joined_at: Date | string;
  is_host: boolean;
}

interface MessageRow {
  id: string;
  chat_id: string;
  sender_id: string;
  body: string;
  created_at: Date | string;
}

@Injectable()
export class PostgresRealtimeRepository implements RealtimeRepository, OnModuleDestroy {
  private pool: Pool | undefined;

  async ensureBookingChat(
    payload: BookingConfirmedPayload
  ): Promise<BookingChatRecord | undefined> {
    return this.withTransaction(async (client) => {
      const activityResult = await client.query<{ id: string; title: string }>(
        `
          select id, title
          from activities
          where id = $1
          for share
        `,
        [payload.activity_id]
      );
      const activity = activityResult.rows[0];

      if (activity === undefined) {
        return undefined;
      }

      const chat = await upsertGroupChat(client, activity.id, activity.title);
      const memberIds = uniqueMemberIds([payload.explorer_id, payload.host_id]);

      await client.query(
        `
          insert into chat_members (chat_id, profile_id)
          select $1::uuid, member_id
          from unnest($2::uuid[]) as members(member_id)
          on conflict (chat_id, profile_id) do nothing
        `,
        [chat.id, memberIds]
      );

      return {
        chat,
        member_ids: memberIds
      };
    }, 'Failed to ensure booking chat');
  }

  async findChatsForProfile(profileId: string): Promise<ChatListItem[]> {
    try {
      const result = await this.getPool().query<ChatListRow>(
        `
          select ${chatListColumns('gc', '$1')}
          from group_chats gc
          join activities a on a.id = gc.activity_id
          left join chat_members cm
            on cm.chat_id = gc.id
           and cm.profile_id = $1
          where cm.profile_id is not null
             or a.host_id = $1
          order by gc.created_at desc, gc.id
        `,
        [profileId]
      );

      return result.rows.map(mapRequiredChatListItem);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read chats');
    }
  }

  async findChat(profileId: string, chatId: string): Promise<ChatListItem | undefined> {
    try {
      const result = await this.getPool().query<ChatListRow>(
        `
          select ${chatListColumns('gc', '$2')}
          from group_chats gc
          join activities a on a.id = gc.activity_id
          left join chat_members cm
            on cm.chat_id = gc.id
           and cm.profile_id = $2
          where gc.id = $1
            and (
              cm.profile_id is not null
              or a.host_id = $2
            )
        `,
        [chatId, profileId]
      );

      return mapChatListItem(result.rows[0]);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read chat');
    }
  }

  async findActivityChat(
    profileId: string,
    activityId: string
  ): Promise<ChatListItem | undefined> {
    try {
      const result = await this.getPool().query<ChatListRow>(
        `
          select ${chatListColumns('gc', '$2')}
          from group_chats gc
          join activities a on a.id = gc.activity_id
          left join chat_members cm
            on cm.chat_id = gc.id
           and cm.profile_id = $2
          where gc.activity_id = $1
            and (
              cm.profile_id is not null
              or a.host_id = $2
            )
        `,
        [activityId, profileId]
      );

      return mapChatListItem(result.rows[0]);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read activity chat');
    }
  }

  async findChatMembers(
    profileId: string,
    chatId: string
  ): Promise<ChatMemberRecord[] | undefined> {
    try {
      if ((await this.findChat(profileId, chatId)) === undefined) {
        return undefined;
      }

      const result = await this.getPool().query<ChatMemberRow>(
        `
          select
            p.id as profile_id,
            p.display_name,
            p.avatar_url,
            cm.joined_at,
            p.id = a.host_id as is_host
          from chat_members cm
          join profiles p on p.id = cm.profile_id
          join group_chats gc on gc.id = cm.chat_id
          join activities a on a.id = gc.activity_id
          where cm.chat_id = $1
          order by
            case when p.id = a.host_id then 0 else 1 end,
            cm.joined_at asc,
            p.display_name asc
        `,
        [chatId]
      );

      return result.rows.map(mapChatMember);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read chat members');
    }
  }

  async findChatIdsForMember(profileId: string): Promise<string[]> {
    try {
      const result = await this.getPool().query<{ chat_id: string }>(
        `
          select chat_id
          from chat_members
          where profile_id = $1
          order by joined_at asc
        `,
        [profileId]
      );

      return result.rows.map((row) => row.chat_id);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read chat memberships');
    }
  }

  async isChatMember(chatId: string, profileId: string): Promise<boolean> {
    try {
      return await isChatMember(this.getPool(), chatId, profileId);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to check chat membership');
    }
  }

  async createMessage(
    senderId: string,
    input: CreateMessageInput
  ): Promise<MessageRecord | undefined> {
    return this.withTransaction(async (client) => {
      if (!(await isChatMember(client, input.chat_id, senderId))) {
        return undefined;
      }

      const result = await client.query<MessageRow>(
        `
          insert into messages (chat_id, sender_id, body)
          values ($1, $2, $3)
          returning ${messageColumns()}
        `,
        [input.chat_id, senderId, input.body]
      );
      const message = mapMessage(result.rows[0]);

      if (message === undefined) {
        throw new InternalServerErrorException('Message row was not returned');
      }

      const chatResult = await client.query<{ activity_id: string | null }>(
        `
          select activity_id
          from group_chats
          where id = $1
        `,
        [message.chat_id]
      );
      const activityId = chatResult.rows[0]?.activity_id ?? null;

      await insertMessageCreatedEvent(client, message, activityId);

      return message;
    }, 'Failed to create chat message');
  }

  async findMessages(
    profileId: string,
    chatId: string,
    input: MessagesPageInput
  ): Promise<MessageRecord[] | undefined> {
    try {
      if (!(await isChatMember(this.getPool(), chatId, profileId))) {
        return undefined;
      }

      const result = await this.getPool().query<MessageRow>(
        `
          select ${messageColumns('m')}
          from messages m
          where m.chat_id = $1
            and m.is_hidden = false
            and (
              $2::timestamptz is null
              or (m.created_at, m.id) < ($2::timestamptz, $3::uuid)
            )
          order by m.created_at desc, m.id desc
          limit $4
        `,
        [chatId, input.cursor?.created_at ?? null, input.cursor?.id ?? null, input.limit]
      );

      return result.rows.map(mapRequiredMessage);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read chat messages');
    }
  }

  async removeChatMember(
    chatId: string,
    profileId: string
  ): Promise<RemoveChatMemberResponse | undefined> {
    try {
      const result = await this.getPool().query<{ chat_id: string; profile_id: string }>(
        `
          delete from chat_members
          where chat_id = $1
            and profile_id = $2
          returning chat_id, profile_id
        `,
        [chatId, profileId]
      );
      const removed = result.rows[0];

      if (removed === undefined) {
        return undefined;
      }

      return {
        chat_id: removed.chat_id,
        profile_id: removed.profile_id,
        removed: true
      };
    } catch (error) {
      throw toRepositoryError(error, 'Failed to remove chat member');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.end();
    }
  }

  private async withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    errorMessage: string
  ): Promise<T> {
    const client = await this.getPool().connect();

    try {
      await client.query('begin');
      const result = await operation(client);
      await client.query('commit');

      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw toRepositoryError(error, errorMessage);
    } finally {
      client.release();
    }
  }

  private getPool(): Pool {
    if (this.pool !== undefined) {
      return this.pool;
    }

    const connectionString = process.env.DATABASE_URL;

    if (connectionString === undefined || connectionString.length === 0) {
      throw new InternalServerErrorException('DATABASE_URL is not configured');
    }

    this.pool = new Pool({
      connectionString,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });

    return this.pool;
  }
}

async function upsertGroupChat(
  client: PoolClient,
  activityId: string,
  title: string
): Promise<GroupChatRecord> {
  const insertedResult = await client.query<GroupChatRow>(
    `
      insert into group_chats (activity_id, title)
      values ($1, $2)
      on conflict (activity_id) do nothing
      returning ${groupChatColumns()}
    `,
    [activityId, title]
  );
  const inserted = mapGroupChat(insertedResult.rows[0]);

  if (inserted !== undefined) {
    return inserted;
  }

  const existingResult = await client.query<GroupChatRow>(
    `
      select ${groupChatColumns()}
      from group_chats
      where activity_id = $1
    `,
    [activityId]
  );
  const existing = mapGroupChat(existingResult.rows[0]);

  if (existing === undefined) {
    throw new InternalServerErrorException('Group chat row was not returned');
  }

  return existing;
}

async function isChatMember(
  client: Pool | PoolClient,
  chatId: string,
  profileId: string
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from chat_members
        where chat_id = $1
          and profile_id = $2
      )
    `,
    [chatId, profileId]
  );

  return result.rows[0]?.exists === true;
}

function chatListColumns(alias: string, actorProfileParam: '$1' | '$2'): string {
  const prefix = `${alias}.`;

  return `
    ${prefix}id,
    ${prefix}activity_id,
    ${prefix}title,
    ${prefix}created_at,
    a.title as activity_title,
    a.pillar::text as activity_pillar,
    a.status::text as activity_status,
    a.host_id = ${actorProfileParam}::uuid as actor_is_host
  `;
}

function groupChatColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;

  return `
    ${prefix}id,
    ${prefix}activity_id,
    ${prefix}title,
    ${prefix}created_at
  `;
}

function messageColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;

  return `
    ${prefix}id,
    ${prefix}chat_id,
    ${prefix}sender_id,
    ${prefix}body,
    ${prefix}created_at
  `;
}

async function insertMessageCreatedEvent(
  client: PoolClient,
  message: MessageRecord,
  activityId: string | null
): Promise<void> {
  const payload: MessageCreatedPayload = {
    message_id: message.id,
    chat_id: message.chat_id,
    sender_id: message.sender_id,
    activity_id: activityId,
    body: message.body,
    created_at: message.created_at
  };

  await client.query(
    `
      insert into domain_events (aggregate_type, aggregate_id, event_type, payload)
      values ('message', $1, 'message.created', $2::jsonb)
    `,
    [message.id, JSON.stringify(withCurrentCorrelation(payload))]
  );
}

function mapGroupChat(row: GroupChatRow | undefined): GroupChatRecord | undefined {
  if (row === undefined) {
    return undefined;
  }

  return mapRequiredGroupChat(row);
}

function mapRequiredGroupChat(row: GroupChatRow): GroupChatRecord {
  return {
    id: row.id,
    activity_id: row.activity_id,
    title: row.title,
    created_at: toIsoTimestamp(row.created_at)
  };
}

function mapChatListItem(row: ChatListRow | undefined): ChatListItem | undefined {
  if (row === undefined) {
    return undefined;
  }

  return mapRequiredChatListItem(row);
}

function mapRequiredChatListItem(row: ChatListRow): ChatListItem {
  const role = row.actor_is_host ? 'host' : 'member';

  return {
    chat: mapRequiredGroupChat(row),
    activity: {
      id: row.activity_id,
      title: row.activity_title,
      pillar: row.activity_pillar,
      status: row.activity_status
    },
    role,
    can_manage: role === 'host'
  };
}

function mapChatMember(row: ChatMemberRow): ChatMemberRecord {
  return {
    profile_id: row.profile_id,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    joined_at: toIsoTimestamp(row.joined_at),
    role: row.is_host ? 'host' : 'member'
  };
}

function mapMessage(row: MessageRow | undefined): MessageRecord | undefined {
  if (row === undefined) {
    return undefined;
  }

  return mapRequiredMessage(row);
}

function mapRequiredMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    chat_id: row.chat_id,
    sender_id: row.sender_id,
    body: row.body,
    created_at: toIsoTimestamp(row.created_at)
  };
}

function uniqueMemberIds(memberIds: string[]): string[] {
  return Array.from(new Set(memberIds));
}

function toIsoTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function toRepositoryError(error: unknown, message: string): HttpException {
  if (error instanceof HttpException) {
    return error;
  }

  return new InternalServerErrorException(message);
}
