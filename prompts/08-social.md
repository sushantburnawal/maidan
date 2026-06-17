Implement a `posts` module. POST /posts { body, media[], linkedActivityId? } (auth). GET /feed —
reverse-chron feed of posts; when linked_activity_id is set, embed a compact activity card
(title, pillar, next slot, price, fairness_score) so the client can deep-link. GET /profiles/:id/posts.
DELETE /posts/:id (author only). Emit 'post.created' to outbox on create. Basic cursor pagination.
DoD: e2e creates a post linked to the Nandi Hills ride and asserts /feed returns it with the embedded
activity card payload.