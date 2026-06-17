export const PAYMENTS_REPOSITORY = Symbol('PAYMENTS_REPOSITORY');
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export const TERMINAL_PAYMENT_STATUSES = ['success', 'failed', 'refunded'] as const;
