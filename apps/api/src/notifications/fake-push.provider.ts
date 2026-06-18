import { Injectable } from '@nestjs/common';

import type { PushMessage, PushProvider } from './notifications.types';

@Injectable()
export class FakePushProvider implements PushProvider {
  readonly sentMessages: PushMessage[] = [];

  async send(message: PushMessage): Promise<void> {
    this.sentMessages.push(clonePushMessage(message));
  }

  reset(): void {
    this.sentMessages.length = 0;
  }
}

function clonePushMessage(message: PushMessage): PushMessage {
  return {
    token: message.token,
    notification: {
      ...message.notification
    },
    data: {
      ...message.data
    }
  };
}
