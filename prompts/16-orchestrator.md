Implement Sutradhar, the conversational agent, in apps/ai exposed as POST /sutradhar/chat
(authenticated via a shared internal token from apps/api, which proxies the user's request).

- Use chat_call() (Sonnet). System prompt: a warm, grounded guide for discovering Maidan activities
  in Bengaluru; never invents activities; speaks in the Move/Learn/Feel vocabulary.
- Tools (function-calling) the agent may call, each backed by real DB queries:
    search_activities(query, pillar?, near?)  -> vector + PostGIS hybrid search over activities
    get_activity(id)                           -> details + next slots + fairness
    get_user_context(profile_id)               -> interests, recent bookings (for personalisation)
  Implement the tool-use loop: model -> tool calls -> results -> final answer. Cap iterations.
- Maintain short conversation memory per session (Redis), and pull a persistent context summary for
  the user so replies feel continuous. Stream the final response.
- Hard rule: recommendations must come from tool results, never hallucinated. If nothing matches, say
  so and offer to register interest (writes a demand_signal).

DoD: an e2e asks "find me a calm morning thing near Indiranagar this weekend"; the agent calls
search_activities, grounds its answer in real seeded rows, and returns activity ids that actually
exist. A query with no matches does not fabricate.