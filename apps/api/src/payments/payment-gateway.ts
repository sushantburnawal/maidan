import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export interface PaymentGatewaySplitInstruction {
  platform: {
    merchantRef: string;
    amountInr: number;
  };
  host: {
    payoutRef: string;
    amountInr: number;
  };
}

export interface PaymentGatewayCreateOrderInput {
  bookingId: string;
  phonepeOrderId: string;
  amountInr: number;
  split: PaymentGatewaySplitInstruction;
}

export interface PaymentGatewayCreateOrderResult {
  orderId: string;
  state: string;
  expireAt: number | null;
  redirectUrl: string | null;
  intentPayload: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

export interface PaymentGatewayWebhookInput {
  authorization: string | string[] | undefined;
  body: unknown;
}

export interface VerifiedPaymentWebhook {
  event: string | null;
  phonepeOrderId: string;
  phonepeTxnId: string | null;
  terminalStatus: 'success' | 'failed' | 'ignored';
  amountInr: number | null;
  failureCode: string | null;
  failureReason: string | null;
  raw: Record<string, unknown>;
}

export interface PaymentGatewayRefundInput {
  paymentId: string;
  bookingId: string;
  phonepeOrderId: string;
  amountInr: number;
}

export interface PaymentGatewayRefundResult {
  refundId: string;
  state: string;
  raw: Record<string, unknown>;
}

export interface PaymentGateway {
  createOrder(input: PaymentGatewayCreateOrderInput): Promise<PaymentGatewayCreateOrderResult>;
  verifyWebhook(input: PaymentGatewayWebhookInput): Promise<VerifiedPaymentWebhook | undefined>;
  refund(input: PaymentGatewayRefundInput): Promise<PaymentGatewayRefundResult>;
}

interface PhonePeAuthToken {
  accessToken: string;
  expiresAtMs: number;
}

interface PhonePeGatewayConfig {
  baseUrl: string;
  authUrl: string;
  clientId: string;
  clientVersion: string;
  clientSecret: string;
  redirectUrl: string;
  splitSettlementEnabled: boolean;
}

export class PhonePeGateway implements PaymentGateway {
  private authToken: PhonePeAuthToken | undefined;

  constructor(private readonly config: PhonePeGatewayConfig = getPhonePeGatewayConfig()) {}

  async createOrder(
    input: PaymentGatewayCreateOrderInput
  ): Promise<PaymentGatewayCreateOrderResult> {
    const token = await this.getAuthToken();
    const response = await fetch(`${this.config.baseUrl}/checkout/v2/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `O-Bearer ${token}`
      },
      body: JSON.stringify(this.toCreateOrderBody(input))
    });
    const body = await readJsonResponse(response);

    if (!response.ok) {
      throw new BadRequestException('PhonePe create order failed');
    }

    return {
      orderId: readString(body, 'orderId') ?? input.phonepeOrderId,
      state: readString(body, 'state') ?? 'PENDING',
      expireAt: readNumber(body, 'expireAt'),
      redirectUrl: readString(body, 'redirectUrl'),
      intentPayload: null,
      raw: body
    };
  }

  async verifyWebhook(input: PaymentGatewayWebhookInput): Promise<VerifiedPaymentWebhook | undefined> {
    if (!verifyPhonePeWebhookAuthorization(input.authorization)) {
      return undefined;
    }

    return parsePhonePeWebhook(input.body);
  }

  async refund(input: PaymentGatewayRefundInput): Promise<PaymentGatewayRefundResult> {
    const token = await this.getAuthToken();
    const merchantRefundId = toPhonePeRefundId(input.phonepeOrderId);
    const response = await fetch(`${this.config.baseUrl}/payments/v2/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `O-Bearer ${token}`
      },
      body: JSON.stringify({
        merchantRefundId,
        originalMerchantOrderId: input.phonepeOrderId,
        amount: inrToPaisa(input.amountInr)
      })
    });
    const body = await readJsonResponse(response);

    if (!response.ok) {
      throw new BadRequestException('PhonePe refund failed');
    }

    return {
      refundId: readString(body, 'refundId') ?? merchantRefundId,
      state: readString(body, 'state') ?? 'PENDING',
      raw: body
    };
  }

  private async getAuthToken(): Promise<string> {
    const cachedToken = this.authToken;
    const refreshBufferMs = 60_000;

    if (cachedToken !== undefined && cachedToken.expiresAtMs - refreshBufferMs > Date.now()) {
      return cachedToken.accessToken;
    }

    const form = new URLSearchParams();
    form.set('client_id', this.config.clientId);
    form.set('client_version', this.config.clientVersion);
    form.set('client_secret', this.config.clientSecret);
    form.set('grant_type', 'client_credentials');

    const response = await fetch(this.config.authUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form
    });
    const body = await readJsonResponse(response);

    if (!response.ok) {
      throw new BadRequestException('PhonePe authorization failed');
    }

    const accessToken = readString(body, 'access_token');
    const expiresAt = readNumber(body, 'expires_at');

    if (accessToken === null || expiresAt === null) {
      throw new InternalServerErrorException('PhonePe authorization response was incomplete');
    }

    this.authToken = {
      accessToken,
      expiresAtMs: expiresAt * 1000
    };

    return accessToken;
  }

  private toCreateOrderBody(input: PaymentGatewayCreateOrderInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
      merchantOrderId: input.phonepeOrderId,
      amount: inrToPaisa(input.amountInr),
      expireAfter: 1200,
      paymentFlow: {
        type: 'PG_CHECKOUT',
        merchantUrls: {
          redirectUrl: this.config.redirectUrl
        }
      },
      disablePaymentRetry: true,
      metaInfo: {
        udf1: input.bookingId,
        udf2: input.split.platform.merchantRef,
        udf3: input.split.platform.amountInr.toString(),
        udf4: input.split.host.payoutRef,
        udf5: input.split.host.amountInr.toString()
      }
    };

    if (this.config.splitSettlementEnabled) {
      body.splitSettlement = {
        recipients: [
          {
            type: 'PLATFORM',
            merchantId: input.split.platform.merchantRef,
            amount: inrToPaisa(input.split.platform.amountInr)
          },
          {
            type: 'HOST',
            merchantId: input.split.host.payoutRef,
            amount: inrToPaisa(input.split.host.amountInr)
          }
        ]
      };
    }

    return body;
  }
}

export class FakePaymentGateway implements PaymentGateway {
  readonly createdOrders: PaymentGatewayCreateOrderInput[] = [];
  readonly refunds: PaymentGatewayRefundInput[] = [];

  async createOrder(
    input: PaymentGatewayCreateOrderInput
  ): Promise<PaymentGatewayCreateOrderResult> {
    this.createdOrders.push(cloneCreateOrderInput(input));

    return {
      orderId: `OMO-${input.phonepeOrderId}`,
      state: 'PENDING',
      expireAt: Date.now() + 1_200_000,
      redirectUrl: `https://fake.phonepe.test/pay/${input.phonepeOrderId}`,
      intentPayload: {
        type: 'PG_CHECKOUT',
        merchantOrderId: input.phonepeOrderId
      },
      raw: {
        fake: true,
        merchantOrderId: input.phonepeOrderId
      }
    };
  }

  async verifyWebhook(input: PaymentGatewayWebhookInput): Promise<VerifiedPaymentWebhook | undefined> {
    if (!verifyPhonePeWebhookAuthorization(input.authorization)) {
      return undefined;
    }

    return parsePhonePeWebhook(input.body);
  }

  async refund(input: PaymentGatewayRefundInput): Promise<PaymentGatewayRefundResult> {
    this.refunds.push({ ...input });

    return {
      refundId: toPhonePeRefundId(input.phonepeOrderId),
      state: 'PENDING',
      raw: {
        fake: true,
        merchantRefundId: toPhonePeRefundId(input.phonepeOrderId)
      }
    };
  }
}

export function shouldUsePhonePeGateway(): boolean {
  return (
    hasEnvValue('PHONEPE_CLIENT_ID') &&
    hasEnvValue('PHONEPE_CLIENT_VERSION') &&
    hasEnvValue('PHONEPE_CLIENT_SECRET')
  );
}

export function createPhonePeWebhookAuthorizationFromSecret(secret: string): string {
  return sha256(secret);
}

export function createPhonePeWebhookAuthorizationFromCredentials(
  username: string,
  password: string
): string {
  return sha256(`${username}:${password}`);
}

function parsePhonePeWebhook(body: unknown): VerifiedPaymentWebhook {
  const raw = asRecord(body);
  const payload = asRecord(raw.payload ?? raw);
  const event = readString(raw, 'event');
  const phonepeOrderId =
    readString(payload, 'merchantOrderId') ?? readString(payload, 'originalMerchantOrderId');

  if (phonepeOrderId === null) {
    throw new BadRequestException('PhonePe webhook is missing merchant order id');
  }

  const state = readString(payload, 'state');
  const paymentDetails = readRecordArray(payload, 'paymentDetails');
  const firstPayment = paymentDetails[0];
  const failureCode =
    readString(payload, 'errorCode') ?? (firstPayment === undefined ? null : readString(firstPayment, 'errorCode'));
  const failureReason =
    readString(payload, 'detailedErrorCode') ??
    (firstPayment === undefined ? null : readString(firstPayment, 'detailedErrorCode'));

  return {
    event,
    phonepeOrderId,
    phonepeTxnId: firstPayment === undefined ? null : readString(firstPayment, 'transactionId'),
    terminalStatus: toTerminalWebhookStatus(event, state),
    amountInr: toInr(readNumber(payload, 'amount')),
    failureCode,
    failureReason,
    raw
  };
}

function toTerminalWebhookStatus(
  event: string | null,
  state: string | null
): VerifiedPaymentWebhook['terminalStatus'] {
  if (event === 'checkout.order.completed' || state === 'COMPLETED') {
    return 'success';
  }

  if (event === 'checkout.order.failed' || state === 'FAILED') {
    return 'failed';
  }

  return 'ignored';
}

function verifyPhonePeWebhookAuthorization(authorization: string | string[] | undefined): boolean {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const providedSignature = normalizeSignature(value);
  const expectedSignature = getExpectedWebhookSignature();

  if (providedSignature === null || expectedSignature === null) {
    return false;
  }

  return timingSafeEqualString(providedSignature, expectedSignature);
}

function getExpectedWebhookSignature(): string | null {
  const username = process.env.PHONEPE_WEBHOOK_USERNAME;
  const password = process.env.PHONEPE_WEBHOOK_PASSWORD;

  if (username !== undefined && username.length > 0 && password !== undefined && password.length > 0) {
    return createPhonePeWebhookAuthorizationFromCredentials(username, password);
  }

  const secret = process.env.PHONEPE_WEBHOOK_SECRET;

  if (secret !== undefined && secret.length > 0) {
    return createPhonePeWebhookAuthorizationFromSecret(secret);
  }

  return null;
}

function normalizeSignature(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  const withoutBearer = trimmed.toLowerCase().startsWith('sha256=')
    ? trimmed.slice('sha256='.length)
    : trimmed;

  return withoutBearer.length === 0 ? null : withoutBearer;
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function getPhonePeGatewayConfig(): PhonePeGatewayConfig {
  const baseUrl = withoutTrailingSlash(
    process.env.PHONEPE_BASE_URL ?? 'https://api-preprod.phonepe.com/apis/pg-sandbox'
  );

  return {
    baseUrl,
    authUrl:
      process.env.PHONEPE_AUTH_URL ??
      (baseUrl.includes('/pg-sandbox')
        ? 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token'
        : 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token'),
    clientId: readRequiredEnv('PHONEPE_CLIENT_ID'),
    clientVersion: readRequiredEnv('PHONEPE_CLIENT_VERSION'),
    clientSecret: readRequiredEnv('PHONEPE_CLIENT_SECRET'),
    redirectUrl: process.env.PHONEPE_REDIRECT_URL ?? process.env.PHONEPE_CALLBACK_URL ?? '',
    splitSettlementEnabled: process.env.PHONEPE_SPLIT_SETTLEMENT_ENABLED === 'true'
  };
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();

  if (text.length === 0) {
    return {};
  }

  return asRecord(JSON.parse(text));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException('Expected object payload');
  }

  return value as Record<string, unknown>;
}

function readRecordArray(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  );
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toInr(amountPaisa: number | null): number | null {
  if (amountPaisa === null) {
    return null;
  }

  if (!Number.isInteger(amountPaisa) || amountPaisa % 100 !== 0) {
    throw new BadRequestException('PhonePe amount must reconcile to whole INR');
  }

  return amountPaisa / 100;
}

function inrToPaisa(amountInr: number): number {
  if (!Number.isInteger(amountInr) || amountInr <= 0) {
    throw new BadRequestException('PhonePe amount must be a positive integer INR value');
  }

  return amountInr * 100;
}

function toPhonePeRefundId(phonepeOrderId: string): string {
  const refundId = `R-${phonepeOrderId}`;

  return refundId.length <= 63 ? refundId : `R-${randomUUID()}`;
}

function cloneCreateOrderInput(
  input: PaymentGatewayCreateOrderInput
): PaymentGatewayCreateOrderInput {
  return {
    bookingId: input.bookingId,
    phonepeOrderId: input.phonepeOrderId,
    amountInr: input.amountInr,
    split: {
      platform: { ...input.split.platform },
      host: { ...input.split.host }
    }
  };
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new InternalServerErrorException(`${name} is not configured`);
  }

  return value;
}

function hasEnvValue(name: string): boolean {
  const value = process.env[name];

  return value !== undefined && value.length > 0;
}

function withoutTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
