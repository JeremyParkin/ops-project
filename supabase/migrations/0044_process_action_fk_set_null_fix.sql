-- Fix for 0041: a composite foreign key's plain "on delete set null" nulls
-- every column in the FK, including workspace_id -- which trips the
-- workspace_id-immutability trigger even though workspace_id's value is
-- unchanged (it's set to null, then implicitly rejected). The fix is
-- PostgreSQL 15's column-scoped SET NULL, which only nulls
-- originating_process_step_run_id.

alter table entity_records
  drop constraint entity_records_originating_step_run_fkey;

alter table entity_records
  add constraint entity_records_originating_step_run_fkey
    foreign key (workspace_id, originating_process_step_run_id)
    references process_step_runs (workspace_id, id)
    on delete set null (originating_process_step_run_id);

alter table process_runs
  drop constraint process_runs_originating_step_run_fkey;

alter table process_runs
  add constraint process_runs_originating_step_run_fkey
    foreign key (workspace_id, originating_process_step_run_id)
    references process_step_runs (workspace_id, id)
    on delete set null (originating_process_step_run_id);
