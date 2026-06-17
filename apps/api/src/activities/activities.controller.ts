import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type {
  ActivityDetailResponse,
  ActivityResponse,
  ActivitySlotRecord,
  NearbyActivityResponse
} from './activities.types';
import { ActivitiesService } from './activities.service';
import { CreateActivityDto } from './dto/create-activity.dto';
import { NearbyActivitiesQueryDto } from './dto/nearby-activities-query.dto';
import { CreateSlotDto, UpdateSlotDto } from './dto/slot.dto';
import { UpdateActivityDto } from './dto/update-activity.dto';

@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activitiesService: ActivitiesService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async createActivity(
    @CurrentUser('profileId') profileId: string,
    @Body() dto: CreateActivityDto
  ): Promise<ActivityResponse> {
    return this.activitiesService.createActivity(profileId, dto);
  }

  @Get('nearby')
  async findNearby(@Query() query: NearbyActivitiesQueryDto): Promise<NearbyActivityResponse[]> {
    return this.activitiesService.findNearby(query);
  }

  @Get(':id')
  async getActivityDetail(
    @Param('id', ParseUUIDPipe) activityId: string
  ): Promise<ActivityDetailResponse> {
    return this.activitiesService.getActivityDetail(activityId);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async updateActivity(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) activityId: string,
    @Body() dto: UpdateActivityDto
  ): Promise<ActivityResponse> {
    return this.activitiesService.updateActivity(activityId, profileId, dto);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async publishActivity(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) activityId: string
  ): Promise<ActivityResponse> {
    return this.activitiesService.publishActivity(activityId, profileId);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async pauseActivity(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) activityId: string
  ): Promise<ActivityResponse> {
    return this.activitiesService.pauseActivity(activityId, profileId);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async archiveActivity(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) activityId: string
  ): Promise<ActivityResponse> {
    return this.activitiesService.archiveActivity(activityId, profileId);
  }

  @Post(':id/slots')
  @UseGuards(JwtAuthGuard)
  async createSlot(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) activityId: string,
    @Body() dto: CreateSlotDto
  ): Promise<ActivitySlotRecord> {
    return this.activitiesService.createSlot(activityId, profileId, dto);
  }

  @Patch(':id/slots/:slotId')
  @UseGuards(JwtAuthGuard)
  async updateSlot(
    @CurrentUser('profileId') profileId: string,
    @Param('id', ParseUUIDPipe) activityId: string,
    @Param('slotId', ParseUUIDPipe) slotId: string,
    @Body() dto: UpdateSlotDto
  ): Promise<ActivitySlotRecord> {
    return this.activitiesService.updateSlot(activityId, slotId, profileId, dto);
  }
}
