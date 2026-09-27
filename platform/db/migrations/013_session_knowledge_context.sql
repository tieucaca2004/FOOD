-- Food Knowledge follow-up context (live Telegram #281-#284, 2026-09-26):
-- after a Food Knowledge REFERENCE list, "sao ko có giá?" must be answered
-- about that list instead of becoming a new search.
--
-- A column of its own, because neither existing store fits:
--   last_search_results_json  catalog merchants for "chọn 2" / follow-ups —
--                             reference places there would become openable;
--   conversation_state_json   ONE merchant's ordering memory, rebuilt from
--                             scratch whenever the merchant changes.
--
-- JSON: {type, rawQuery, query, matchedIds[], shownCount, total, touchedAt}.
-- NULL = no reference list is being discussed. Nothing else is changed.

ALTER TABLE platform_sessions ADD COLUMN knowledge_context_json TEXT;
