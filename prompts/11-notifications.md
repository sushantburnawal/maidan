Implement a `notifications` BullMQ consumer (QUEUE_NOTIFICATIONS) that sends FCM push. Wrap FCM behind
a PushProvider (FakePushProvider for tests). Store device tokens via POST /me/devices. Map events to
templates: booking.confirmed -> "You're in! …", booking.cancelled, payment.failed, message.created
(only when recipient offline — check presence in Redis). Respect a per-user mute setting.
DoD: consuming a sample job calls the provider with a correctly templated payload; offline-gating works.