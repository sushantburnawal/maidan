Implement a `realtime` WebSocket gateway in apps/api (socket.io over the Fastify server, JWT auth on
connect).

Group chat:
- A group_chat exists per activity (auto-create on first confirmed booking, add explorer + host to
  chat_members; do this by consuming 'booking.confirmed').
- Rooms keyed by chat_id; membership enforced from chat_members. Events: join, message:send
  (persists a messages row + emits 'message.created' to outbox), message:new broadcast, typing,
  presence. History via GET /chats/:id/messages (REST, paginated).
Live updates:
- A per-user room for push-style nudges (e.g. booking confirmed, new feed item) so the app can update
  without polling. Server emits to these rooms when relevant domain events fly by.

Use Redis adapter for socket.io so it scales horizontally on Railway.

DoD: e2e (two socket clients) — host and explorer both land in the activity chat after a confirmed
booking, exchange a message, and a messages row + 'message.created' outbox event are written.