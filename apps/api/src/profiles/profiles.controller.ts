import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfilesService } from './profiles.service';
import type {
  HostProfileRecord,
  PrivateProfileRecord,
  PrivateProfileResponse,
  PublicProfileResponse
} from './profiles.types';

@Controller()
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(
    @CurrentUser('profileId') profileId: string
  ): Promise<PrivateProfileResponse> {
    return this.profilesService.getMe(profileId);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  async updateMe(
    @CurrentUser('profileId') profileId: string,
    @Body() dto: UpdateProfileDto
  ): Promise<PrivateProfileRecord> {
    return this.profilesService.updateMe(profileId, dto);
  }

  @Post('me/become-host')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async becomeHost(
    @CurrentUser('profileId') profileId: string
  ): Promise<HostProfileRecord> {
    return this.profilesService.becomeHost(profileId);
  }

  @Get('profiles/:id')
  @UseGuards(OptionalJwtAuthGuard)
  async getPublicProfile(
    @Param('id', ParseUUIDPipe) profileId: string,
    @CurrentUser('profileId') viewerId?: string
  ): Promise<PublicProfileResponse> {
    return this.profilesService.getPublicProfile(profileId, viewerId);
  }
}
