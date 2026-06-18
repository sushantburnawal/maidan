import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { NotificationsService } from './notifications.service';
import type { NotificationDeviceRecord } from './notifications.types';

@Controller()
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('me/devices')
  @HttpCode(200)
  async registerDevice(
    @CurrentUser('profileId') profileId: string,
    @Body() dto: RegisterDeviceDto
  ): Promise<NotificationDeviceRecord> {
    return this.notificationsService.registerDevice(profileId, dto);
  }
}
