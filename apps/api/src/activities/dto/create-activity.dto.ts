import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested
} from 'class-validator';

import { ACTIVITY_PILLARS } from '../activities.constants';
import type { ActivityMedia } from '../activities.types';
import { ActivityLocationDto } from './activity-location.dto';

export class CreateActivityDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsString()
  @MinLength(1)
  description!: string;

  @IsIn(ACTIVITY_PILLARS)
  pillar!: (typeof ACTIVITY_PILLARS)[number];

  @IsString()
  @MinLength(1)
  category!: string;

  @IsString()
  @MinLength(1)
  meetingPoint!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => ActivityLocationDto)
  location!: ActivityLocationDto;

  @IsInt()
  @Min(0)
  basePriceInr!: number;

  @IsInt()
  @Min(1)
  capacity!: number;

  @IsOptional()
  @IsArray()
  media?: ActivityMedia;
}
