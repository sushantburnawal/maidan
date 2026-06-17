import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested
} from 'class-validator';

import { ACTIVITY_PILLARS } from '../activities.constants';
import type { ActivityMedia } from '../activities.types';
import { ActivityLocationDto } from './activity-location.dto';

export class UpdateActivityDto {
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  title?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  description?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsIn(ACTIVITY_PILLARS)
  pillar?: (typeof ACTIVITY_PILLARS)[number];

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  category?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  meetingPoint?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => ActivityLocationDto)
  location?: ActivityLocationDto;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  basePriceInr?: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  capacity?: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsArray()
  media?: ActivityMedia;
}
