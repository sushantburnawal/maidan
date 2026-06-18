Add a moderation worker consuming QUEUE_MODERATION for 'post.created' and 'message.created'. Fetch the
content, call cheap_call() (Haiku) with a strict rubric prompt that returns ONLY JSON
{allow:bool, categories:[], severity:0-3, reason}. Use prompt caching for the static rubric. On
disallow: flag the row (add a moderation_status column via migration: 'pending'|'ok'|'blocked') and,
if severe, hide it and emit a notification to the author. Batch low-traffic items on a short timer to
cut cost. Be conservative and log every decision to ai_jobs.
DoD: a benign message is marked ok; a seeded abusive sample is blocked; output is always valid JSON
(parse-fails are retried, then dead-lettered, never silently allowed).