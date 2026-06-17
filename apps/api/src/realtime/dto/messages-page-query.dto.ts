import { Type } from 'class-transformer';
import { IsInt, IsString, Max, Min, ValidateIf } from 'class-validator';

import { MAX_MESSAGES_LIMIT } from '../realtime.constants';

export class MessagesPageQueryDto {
  @ValidateIf((_, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MESSAGES_LIMIT)
  limit?: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  cursor?: string;
}
