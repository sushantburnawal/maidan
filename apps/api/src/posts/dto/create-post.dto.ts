import { IsArray, IsOptional, IsString, IsUUID, MinLength, ValidateIf } from 'class-validator';

import type { PostMedia } from '../posts.types';

export class CreatePostDto {
  @IsString()
  @MinLength(1)
  body!: string;

  @IsOptional()
  @IsArray()
  media?: PostMedia;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsUUID()
  linkedActivityId?: string | null;
}
