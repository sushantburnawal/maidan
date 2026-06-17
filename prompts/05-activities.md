Implement an `activities` module.

Endpoints:
- POST /activities (host only) — create draft. body validated by CreateActivityDto.
- PATCH /activities/:id, POST /activities/:id/publish, /pause, /archive (owner only).
- POST /activities/:id/slots, PATCH slots (owner only).
- GET /activities/nearby?lat&lng&radiusKm&pillar — map-first feed. Use PostGIS ST_DWithin on
  geography; return activities with distance_m, next open slot, and fairness_score. Order by a blend
  of distance and recency. Support a bbox variant for map panning.
- GET /activities/:id — full detail incl. upcoming open slots.

Maidan Way fairness:
- On create/update, compute fairness_score by comparing base_price_inr to the median price of
  published activities in the same category (fallback: same pillar). Expose it as a 0–100 "fairness
  meter" value where pricing far above the category median lowers the score. Persist it.
- Return, alongside the activity, a `fairness` object { score, category_median_inr, suggestion }
  the client can render as the fairness meter. Never block publishing — this is advisory UX.

Events (write to the outbox in the SAME transaction as the write):
- publish -> 'activity.published'; meaningful edits -> 'activity.updated'.

DoD: e2e proves (a) nearby returns Nandi Hills within 30km of its coords and excludes far ones,
(b) an over-priced activity gets a lower fairness_score than a median-priced one,
(c) publishing inserts exactly one domain_events row in the same tx.