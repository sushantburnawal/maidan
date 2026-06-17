import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import type { SmsProvider } from './auth.types';

export interface SentOtpMessage {
  phone: string;
  code: string;
}

@Injectable()
export class FakeSmsProvider implements SmsProvider {
  private readonly logger = new Logger(FakeSmsProvider.name);
  private readonly messages: SentOtpMessage[] = [];

  async sendOtp(phone: string, code: string): Promise<void> {
    this.messages.push({ phone, code });
    this.logger.log(`Fake OTP for ${phone}: ${code}`);
  }

  getLastOtp(phone: string): string | undefined {
    return this.messages
      .slice()
      .reverse()
      .find((message) => message.phone === phone)?.code;
  }
}

@Injectable()
export class Msg91SmsProvider implements SmsProvider {
  async sendOtp(phone: string, code: string): Promise<void> {
    const authKey = getMsg91AuthKey();
    const senderId = process.env.MSG91_SENDER_ID ?? 'MAIDAN';
    const templateId = process.env.MSG91_OTP_TEMPLATE_ID;

    if (authKey === undefined || templateId === undefined || templateId.length === 0) {
      throw new ServiceUnavailableException('MSG91 is not configured');
    }

    const response = await fetch('https://control.msg91.com/api/v5/otp', {
      method: 'POST',
      headers: {
        authkey: authKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        mobile: phone.replace(/^\+/, ''),
        otp: code,
        sender: senderId,
        template_id: templateId
      })
    });

    if (!response.ok) {
      throw new ServiceUnavailableException('MSG91 failed to send OTP');
    }
  }
}

export function getMsg91AuthKey(): string | undefined {
  const apiKey = configuredSecret(process.env.MSG91_API_KEY);

  return apiKey;
}

function configuredSecret(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value === 'replace-me') {
    return undefined;
  }

  return value;
}
