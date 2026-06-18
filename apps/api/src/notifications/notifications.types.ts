export interface RegisterDeviceInput {
  token: string;
}

export interface NotificationDeviceRecord {
  id: string;
  profile_id: string;
  token: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface PushTarget {
  profile_id: string;
  push_muted: boolean;
  device_tokens: string[];
}

export interface PushNotification {
  title: string;
  body: string;
}

export interface PushMessage {
  token: string;
  notification: PushNotification;
  data: Record<string, string>;
}

export interface PushProvider {
  send(message: PushMessage): Promise<void>;
}

export interface PresenceChecker {
  isOnline(profileId: string): Promise<boolean>;
}

export interface NotificationsRepository {
  upsertDevice(
    profileId: string,
    input: RegisterDeviceInput
  ): Promise<NotificationDeviceRecord>;
  findPushTarget(profileId: string): Promise<PushTarget | undefined>;
  findBookingExplorerId(bookingId: string): Promise<string | undefined>;
  findChatRecipientIds(chatId: string, senderId: string): Promise<string[]>;
}
