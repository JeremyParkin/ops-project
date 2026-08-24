-- Correct already-applied 0035 environments where Supabase retained an
-- explicit anon EXECUTE grant despite the PUBLIC revocation.
revoke all on function decide_process_approval_authorized(uuid, uuid, uuid, uuid) from public;
revoke all on function decide_process_approval_authorized(uuid, uuid, uuid, uuid) from anon;
grant execute on function decide_process_approval_authorized(uuid, uuid, uuid, uuid) to authenticated, service_role;
