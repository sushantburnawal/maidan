import { IsString, Matches } from 'class-validator';

export class VerifyOtpDto {
  @IsString()
  @Matches(/^\+[1-9][0-9]{1,14}$/)
  phone!: string;

  @IsString()
  @Matches(/^[0-9]{6}$/)
  code!: string;
}
