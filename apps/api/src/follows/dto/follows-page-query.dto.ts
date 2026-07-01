import { Type } from 'class-transformer';
import { IsInt, IsString, Max, Min, MinLength, ValidateIf } from 'class-validator';

export class FollowsPageQueryDto {
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  cursor?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
