import type { BookingStatus, PaymentStatus } from '@maidan/shared';

import type {
  PaymentGatewayCreateOrderInput,
  PaymentGatewayCreateOrderResult,
  PaymentGatewayRefundResult,
  VerifiedPaymentWebhook
} from './payment-gateway';
import type { PaymentsConfig } from './payments.config';

export interface PaymentRecord {
  id: string;
  booking_id: string;
  phonepe_order_id: string;
  phonepe_txn_id: string | null;
  amount_inr: number;
  platform_fee_inr: number;
  host_payout_inr: number;
  status: PaymentStatus;
  idempotency_key: string;
  raw_callback: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentBookingRecord {
  id: string;
  slot_id: string;
  activity_id: string;
  explorer_id: string;
  host_id: string;
  headcount: number;
  amount_inr: number;
  status: BookingStatus;
  payment_id: string | null;
}

export interface InitiatePaymentRepositoryInput {
  booking_id: string;
  explorer_id: string;
  phonepe_order_id: string;
  config: PaymentsConfig;
}

export interface InitiatePaymentRepositoryResult {
  payment: PaymentRecord;
  gatewayOrder: PaymentGatewayCreateOrderInput | null;
  alreadyPaid: boolean;
}

export interface InitPaymentResponse {
  payment: PaymentRecord;
  gateway: PaymentGatewayCreateOrderResult | null;
  already_paid: boolean;
}

export interface PaymentWebhookRepositoryResult {
  payment: PaymentRecord | null;
  applied: boolean;
  terminal_status: PaymentStatus | 'ignored';
}

export interface PaymentWebhookResponse {
  received: boolean;
  applied: boolean;
  payment: PaymentRecord | null;
  terminal_status: PaymentStatus | 'ignored';
}

export interface RefundablePaymentRecord {
  payment_id: string;
  booking_id: string;
  phonepe_order_id: string;
  amount_inr: number;
}

export interface PaymentsRepository {
  initiatePayment(
    input: InitiatePaymentRepositoryInput
  ): Promise<InitiatePaymentRepositoryResult | undefined>;
  applyTerminalWebhook(
    webhook: VerifiedPaymentWebhook
  ): Promise<PaymentWebhookRepositoryResult | undefined>;
  findRefundablePaymentForCancelledBooking(
    bookingId: string
  ): Promise<RefundablePaymentRecord | undefined>;
  markPaymentRefunded(
    paymentId: string,
    refund: PaymentGatewayRefundResult
  ): Promise<PaymentRecord | undefined>;
}
