import { IsString, Matches } from 'class-validator';

export class RequestOtpDto {
  @IsString()
  @Matches(/^\+[1-9][0-9]{1,14}$/)
  phone!: string;
}
