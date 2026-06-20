import { Body, Controller, HttpCode, Post, Res, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SutradharChatDto } from './dto/sutradhar-chat.dto';
import { SutradharService } from './sutradhar.service';

interface StreamReply {
  header(name: string, value: string): StreamReply;
  send(payload: unknown): void;
}

@Controller('sutradhar')
@UseGuards(JwtAuthGuard)
export class SutradharController {
  constructor(private readonly sutradharService: SutradharService) {}

  @Post('chat')
  @HttpCode(200)
  async chat(
    @CurrentUser('profileId') profileId: string,
    @Body() dto: SutradharChatDto,
    @Res() reply: StreamReply
  ): Promise<void> {
    const response = await this.sutradharService.chat(profileId, dto);

    reply.header('content-type', response.contentType);
    reply.header('cache-control', 'no-cache');
    reply.send(response.body);
  }
}
