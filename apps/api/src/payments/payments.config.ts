import { InternalServerErrorException } from '@nestjs/common';

import type { PlatformFeeConfig } from './payments.splits';

export interface PaymentsConfig extends PlatformFeeConfig {
  maidanMerchantRef: string;
}

export function getPaymentsConfig(): PaymentsConfig {
  return {
    platformFeePct: readNonNegativeNumber('PLATFORM_FEE_PCT', 15),
    platformFeeFloorInr: readNonNegativeInteger('PLATFORM_FEE_FLOOR_INR', 0),
    maidanMerchantRef:
      process.env.MAIDAN_PHONEPE_MERCHANT_REF ?? process.env.PHONEPE_MERCHANT_ID ?? 'maidan'
  };
}

function readNonNegativeInteger(name: string, defaultValue: number): number {
  const value = readNonNegativeNumber(name, defaultValue);

  if (!Number.isInteger(value)) {
    throw new InternalServerErrorException(`${name} must be an integer`);
  }

  return value;
}

function readNonNegativeNumber(name: string, defaultValue: number): number {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue.length === 0) {
    return defaultValue;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value < 0) {
    throw new InternalServerErrorException(`${name} must be a non-negative number`);
  }

  return value;
}
