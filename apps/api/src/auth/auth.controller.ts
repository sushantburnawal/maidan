import { Body, Controller, HttpCode, Post } from '@nestjs/common';

import { AuthService } from './auth.service';
import type { AuthTokens, FirebaseGoogleAuthResponse } from './auth.types';
import { FirebaseGoogleAuthDto } from './dto/firebase-google-auth.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('request-otp')
  @HttpCode(200)
  async requestOtp(@Body() dto: RequestOtpDto): Promise<{ ok: true; expiresInSeconds: number }> {
    return this.authService.requestOtp(dto.phone);
  }

  @Post('verify-otp')
  @HttpCode(200)
  async verifyOtp(@Body() dto: VerifyOtpDto): Promise<AuthTokens> {
    return this.authService.verifyOtp(dto.phone, dto.code);
  }

  @Post('firebase/google')
  @HttpCode(200)
  async firebaseGoogle(@Body() dto: FirebaseGoogleAuthDto): Promise<FirebaseGoogleAuthResponse> {
    return this.authService.signInWithFirebaseGoogle(dto.idToken, dto.displayName);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokens> {
    return this.authService.refresh(dto.refreshToken);
  }
}
