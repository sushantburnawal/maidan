import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MessagesPageQueryDto } from './dto/messages-page-query.dto';
import { RealtimeService } from './realtime.service';
import type { PaginatedMessagesResponse } from './realtime.types';

@Controller('chats')
export class ChatsController {
  constructor(private readonly realtimeService: RealtimeService) {}

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
