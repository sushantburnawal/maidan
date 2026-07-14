import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class FirebaseGoogleAuthDto {
  @IsString()
  @MinLength(1)
  idToken!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName?: string;
}
