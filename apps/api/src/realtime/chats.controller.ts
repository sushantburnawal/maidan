import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MessagesPageQueryDto } from './dto/messages-page-query.dto';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';
import type {
  ChatListItem,
  ChatMemberRecord,
  PaginatedMessagesResponse,
  RemoveChatMemberResponse
} from './realtime.types';

@Controller('chats')
export class ChatsController {
  constructor(
    private readonly realtimeService: RealtimeService,
    private readonly realtimeGateway: RealtimeGateway
  ) {}

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  async findMine(@CurrentUser('profileId') profileId: string): Promise<ChatListItem[]> {
    return this.realtimeService.findMyChats(profileId);
  }

  @Get(':id/members')
  @UseGuards(JwtAuthGuard)
  async findMembers(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) chatId: string
  ): Promise<ChatMemberRecord[]> {
    return this.realtimeService.findChatMembers(profileId, chatId);
  }

  @Delete(':id/members/:profileId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async removeMember(
    @CurrentUser('profileId') actorProfileId: string,
    @Param('id', ParseUUIDPipe) chatId: string,
    @Param('profileId', ParseUUIDPipe) targetProfileId: string
  ): Promise<RemoveChatMemberResponse> {
    const removed = await this.realtimeService.removeChatMember(
      actorProfileId,
      chatId,
      targetProfileId
    );

    await this.realtimeGateway.publishChatMemberRemoved(removed);

    return removed;
  }

  @Get(':id/messages')
  @UseGuards(JwtAuthGuard)
  async findMessages(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) chatId: string,
    @Query() query: MessagesPageQueryDto
  ): Promise<PaginatedMessagesResponse> {
    return this.realtimeService.findMessages(profileId, chatId, query);
  }
}
