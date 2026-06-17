import { IsIn, IsInt, IsISO8601, Min, ValidateIf } from 'class-validator';

import { SLOT_STATUSES } from '../activities.constants';

export class CreateSlotDto {
  @IsISO8601({ strict: true })
  startsAt!: string;

  @IsISO8601({ strict: true })
  endsAt!: string;

  @IsInt()
  @Min(1)
  capacity!: number;
}

export class UpdateSlotDto {
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true })
  startsAt?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true })
  endsAt?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  capacity?: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsIn(SLOT_STATUSES)
  status?: (typeof SLOT_STATUSES)[number];
}
