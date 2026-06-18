import { IsString, MinLength } from 'class-validator';

export class RegisterDeviceDto {
  @IsString()
  @MinLength(1)
  token!: string;
}
