-- Fix for 0041: CREATE OR REPLACE FUNCTION does not replace an existing
-- function when a parameter is appended, even with a default -- Postgres
-- matches function identity by the full input parameter type list, so
-- appending p_originating_process_step_run_id created a second overload
-- alongside the original, leaving calls that omit it (every existing
-- caller, exactly as intended) ambiguous between the two. The fix is to
-- drop each stale old-arity overload outright; the new 5-parameter versions
-- from 0041 (including their grants) are unaffected and already correct.

drop function if exists create_entity_record_with_relations(uuid, uuid, jsonb, jsonb);
drop function if exists create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb);
drop function if exists start_process_run_authorized(uuid, uuid, uuid, uuid);
