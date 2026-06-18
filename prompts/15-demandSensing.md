Add a demand-sensing worker — the invisible market-maker. This is background AI; if it were switched
off, latent-interest detection and supply bootstrapping would break, but browsing would still work.

Inputs (read-only over asyncpg): recent bookings, searches/nearby queries if logged, posts, chat
topics, slot fill rates, geographic clustering of explorers by interest.
Job (scheduled nightly + triggerable): per (area, pillar) bucket, summarise signals and call
cheap_call() (Haiku, BATCHED, prompt-cached) to produce a structured read of latent demand:
  { area, pillar, signal_strength 0-1, unmet_interest:[tags], suggested_action, evidence }.
Persist to demand_signals. Where signal is strong but supply is thin, write an ai_jobs row of kind
'host_nudge' (a hook the API/notifications can later turn into a "Hosts wanted for X near Y" prompt).
Keep it explainable: always store the evidence that justified each signal.
DoD: running the batch on seeded data produces demand_signals rows with non-empty evidence and at
least one host_nudge where a popular pillar in an area lacks open slots.