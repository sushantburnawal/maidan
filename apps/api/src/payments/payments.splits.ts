import { BadRequestException } from '@nestjs/common';

export interface PlatformFeeConfig {
  platformFeePct: number;
  platformFeeFloorInr: number;
}

export interface PaymentSplit {
  platform_fee_inr: number;
  host_payout_inr: number;
}

export function computePaymentSplit(amountInr: number, config: PlatformFeeConfig): PaymentSplit {
  if (!Number.isInteger(amountInr) || amountInr < 0) {
    throw new BadRequestException('amount_inr must be a non-negative integer');
  }

  const pctFee = Math.ceil((amountInr * config.platformFeePct) / 100);
  const platformFeeInr = Math.min(amountInr, Math.max(pctFee, config.platformFeeFloorInr));
  const hostPayoutInr = amountInr - platformFeeInr;

  if (platformFeeInr + hostPayoutInr !== amountInr) {
    throw new BadRequestException('Payment split does not reconcile to booking amount');
  }

  return {
    platform_fee_inr: platformFeeInr,
    host_payout_inr: hostPayoutInr
  };
}
