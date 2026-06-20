import { IsString, Length } from 'class-validator';

export class SutradharChatDto {
  @IsString()
  @Length(1, 2000)
  message!: string;

  @IsString()
  @Length(1, 160)
  sessionId!: string;
}
