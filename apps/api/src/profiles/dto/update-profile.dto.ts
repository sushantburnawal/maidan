import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsObject,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested
} from 'class-validator';

export class HomeLocationDto {
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
  lng!: number;
}

export class UpdateProfileDto {
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  display_name?: string;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  bio?: string | null;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  interests?: string[];

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  avatar_url?: string | null;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => HomeLocationDto)
  home_location?: HomeLocationDto | null;
}
