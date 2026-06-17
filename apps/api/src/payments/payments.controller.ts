import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InitPaymentDto } from './dto/init-payment.dto';
import { PaymentsService } from './payments.service';
import type { InitPaymentResponse, PaymentWebhookResponse } from './payments.types';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('init')
  @UseGuards(JwtAuthGuard)
  async initPayment(
    @CurrentUser('profileId') profileId: string,
    @Body() dto: InitPaymentDto
  ): Promise<InitPaymentResponse> {
    return this.paymentsService.initPayment(profileId, dto);
  }

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown
  ): Promise<PaymentWebhookResponse> {
    return this.paymentsService.handleWebhook(authorization, body);
  }
}
