import { Type } from 'class-transformer';
import { IsIn, IsNumber, Max, Min, ValidateIf } from 'class-validator';

import { ACTIVITY_PILLARS } from '../activities.constants';

export class NearbyActivitiesQueryDto {
  @ValidateIf((_, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  lat?: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
  lng?: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0.1)
  @Max(100)
  radiusKm?: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsIn(ACTIVITY_PILLARS)
  pillar?: (typeof ACTIVITY_PILLARS)[number];

  @ValidateIf((_, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  north?: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  south?: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
  east?: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
  west?: number;
}
