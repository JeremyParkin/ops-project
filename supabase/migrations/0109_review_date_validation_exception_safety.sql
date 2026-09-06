-- Corrective migration for 0108 (applied). Live verification against the
-- applied migration found a real defect in private.is_valid_review_date:
-- Postgres's to_date(..., 'YYYY-MM-DD') does NOT silently normalize every
-- impossible calendar date the way the codebase's other regex+round-trip
-- date-validation call sites implicitly assume -- for a value that already
-- matches the YYYY-MM-DD shape but names a day that does not exist in that
-- month (e.g. "2026-02-30", or an out-of-range month like "2026-13-40"),
-- to_date raises `date/time field value out of range` (SQLSTATE 22008)
-- rather than returning a value the round-trip check could reject. As a
-- `language sql` function, private.is_valid_review_date had no way to trap
-- that exception, so it propagated a raw Postgres error out of all three
-- consumers (the presentation configuration RPC's existing-Finalized-
-- record count query, finalize_quality_review_authorized, and
-- list_person_quality_reviews_authorized's row filter) instead of the
-- intended truthful, friendly rejection. Confirmed empirically via the
-- live focused suite (lib/domain/quality-review-presentation-commit.test.ts)
-- against the applied 0108 migration -- reproducible with "2026-02-30" and
-- "2026-13-40".
--
-- Fix: redefine the same predicate (identical signature, so every existing
-- caller is fixed at once -- no other function in this migration or 0108
-- needs to change) as `language plpgsql` with an explicit exception trap
-- around the to_date/to_char round-trip. A well-formed-but-impossible date
-- now correctly returns false instead of raising; every other case
-- (missing/null, non-matching format, genuinely valid dates including leap
-- days) is unchanged, since those never reach to_date at all or already
-- returned the correct answer.
create or replace function private.is_valid_review_date(p_value text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;

  return to_char(to_date(p_value, 'YYYY-MM-DD'), 'YYYY-MM-DD') = p_value;
exception
  when datetime_field_overflow or invalid_datetime_format then
    return false;
end;
$$;

revoke all on function private.is_valid_review_date(text) from public, anon, authenticated;
