Add an embeddings worker. Load a self-hosted sentence-embedding model (768-dim, e.g. a
sentence-transformers model) once at startup behind an Embedder interface. Consume QUEUE_EMBEDDINGS
(and handle 'activity.published'/'activity.updated' from the bus): build the text (title + description
+ category + pillar), embed, and UPDATE activities.embedding. Add a backfill command that embeds all
activities with NULL embedding (uses the Prompt-1b seed). No per-token cost — keep it on the box.
DoD: after running backfill on seeds, every published activity has a non-null embedding, and a cosine
<=> query returns semantically near activities (e.g. two trail-ride activities rank close).