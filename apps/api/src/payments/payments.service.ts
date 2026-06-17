import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';

import { PAYMENT_GATEWAY, PAYMENTS_REPOSITORY } from './payments.constants';
import { getPaymentsConfig } from './payments.config';
import type { PaymentGateway } from './payment-gateway';
import type { InitPaymentDto } from './dto/init-payment.dto';
import type {
  InitPaymentResponse,
  PaymentWebhookResponse,
  PaymentsRepository
} from './payments.types';

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(PAYMENTS_REPOSITORY) private readonly repository: PaymentsRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway
  ) {}

  async initPayment(explorerId: string, dto: InitPaymentDto): Promise<InitPaymentResponse> {
    const result = await this.repository.initiatePayment({
      booking_id: dto.bookingId,
      explorer_id: explorerId,
      phonepe_order_id: toPhonePeOrderId(dto.bookingId),
      config: getPaymentsConfig()
    });

    if (result === undefined) {
      throw new NotFoundException('Booking not found');
    }

    if (result.gatewayOrder === null) {
      return {
        payment: result.payment,
        gateway: null,
        already_paid: result.alreadyPaid
      };
    }

    const gatewayResult = await this.gateway.createOrder(result.gatewayOrder);

    return {
      payment: result.payment,
      gateway: gatewayResult,
      already_paid: result.alreadyPaid
    };
  }

  async handleWebhook(
    authorization: string | string[] | undefined,
    body: unknown
  ): Promise<PaymentWebhookResponse> {
    const webhook = await this.gateway.verifyWebhook({ authorization, body });

    if (webhook === undefined) {
      throw new UnauthorizedException('Invalid PhonePe webhook signature');
    }

    const result = await this.repository.applyTerminalWebhook(webhook);

    if (result === undefined) {
      throw new NotFoundException('Payment not found');
    }

    return {
      received: true,
      applied: result.applied,
      payment: result.payment,
      terminal_status: result.terminal_status
    };
  }

  async refundCancelledBookingIfPaid(bookingId: string): Promise<void> {
    const payment = await this.repository.findRefundablePaymentForCancelledBooking(bookingId);

    if (payment === undefined) {
      return;
    }

    const refund = await this.gateway.refund({
      paymentId: payment.payment_id,
      bookingId: payment.booking_id,
      phonepeOrderId: payment.phonepe_order_id,
      amountInr: payment.amount_inr
    });

    await this.repository.markPaymentRefunded(payment.payment_id, refund);
  }
}

function toPhonePeOrderId(bookingId: string): string {
  return `MAIDAN-${bookingId}`;
}
