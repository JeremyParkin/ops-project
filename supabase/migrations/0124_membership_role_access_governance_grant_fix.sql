-- Corrective migration for 0123: newly-created public governance wrappers
-- otherwise inherit PostgreSQL's default EXECUTE privilege for PUBLIC.
-- Preserve the established RPC boundary: authenticated and service_role only.

revoke all on function public.create_workspace_invitation_authorized(uuid, text, uuid, boolean),
  public.cancel_workspace_invitation_authorized(uuid, uuid),
  public.accept_workspace_invitation_authorized(uuid),
  public.deactivate_workspace_member_authorized(uuid, uuid),
  public.reactivate_workspace_member_authorized(uuid, uuid),
  public.set_workspace_member_role_authorized(uuid, uuid, uuid),
  public.create_workspace_role_authorized(uuid, text, text, jsonb),
  public.update_workspace_role_authorized(uuid, uuid, text, text, jsonb),
  public.delete_workspace_role_with_reassignment_authorized(uuid, uuid, uuid)
  from public, anon;

grant execute on function public.create_workspace_invitation_authorized(uuid, text, uuid, boolean),
  public.cancel_workspace_invitation_authorized(uuid, uuid),
  public.accept_workspace_invitation_authorized(uuid),
  public.deactivate_workspace_member_authorized(uuid, uuid),
  public.reactivate_workspace_member_authorized(uuid, uuid),
  public.set_workspace_member_role_authorized(uuid, uuid, uuid),
  public.create_workspace_role_authorized(uuid, text, text, jsonb),
  public.update_workspace_role_authorized(uuid, uuid, text, text, jsonb),
  public.delete_workspace_role_with_reassignment_authorized(uuid, uuid, uuid)
  to authenticated, service_role;
