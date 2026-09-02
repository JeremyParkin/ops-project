-- Phase 9 visual polish: expand the fixed Choice color palette from 6 to 12
-- keys (adds orange, teal, cyan, indigo, rose, lime alongside the existing
-- gray, red, amber, emerald, blue, violet). Additive only -- widens the
-- allowed set, drops nothing existing, and touches no other schema.
--
-- field_choice_options.color's check constraint (added in migration 0080)
-- was declared inline on the column with no explicit name, so Postgres
-- auto-generated it. Rather than hardcode a guessed name, this drops it the
-- same way migration 0031 (process_step_runs) already established for this
-- repo: look it up live via pg_constraint at apply time. This table has
-- exactly one contype = 'c' constraint (color) -- workspace/field/id and
-- workspace/field/position are `unique` (contype = 'u'), not checks -- so
-- scoping to contype = 'c' is safe here without an explicit name filter.
do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'field_choice_options'::regclass
      and contype = 'c'
  loop
    execute format('alter table field_choice_options drop constraint %I', constraint_row.conname);
  end loop;
end;
$$;

alter table field_choice_options
  add constraint field_choice_options_color_check
  check (color is null or color in (
    'gray', 'red', 'amber', 'emerald', 'blue', 'violet',
    'orange', 'teal', 'cyan', 'indigo', 'rose', 'lime'
  ));
