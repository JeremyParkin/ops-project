import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";
import { listWorkspaceMemberIdentities } from "./process-repository";
import type { WorkspaceMemberIdentity } from "./process-types";

export async function getPersonEntityTypeId({
  workspaceId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  supabase?: SupabaseServerClient;
}): Promise<string | null> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase
    .from("workspaces")
    .select("person_entity_type_id")
    .eq("id", workspaceId)
    .single<{ person_entity_type_id: string | null }>();

  if (error) {
    throw new Error(`Unable to load the workspace's Person type: ${error.message}`);
  }

  return data.person_entity_type_id;
}

export async function setPersonEntityType({
  workspaceId,
  entityTypeId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityTypeId: string | null;
  supabase?: SupabaseServerClient;
}): Promise<void> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("set_person_entity_type_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
  });

  if (error) {
    throw new Error(`Unable to set the Person type: ${error.message}`);
  }
}

export async function getPersonLink({
  workspaceId,
  entityRecordId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityRecordId: string;
  supabase?: SupabaseServerClient;
}): Promise<{ userId: string } | null> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase
    .from("entity_record_person_links")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("entity_record_id", entityRecordId)
    .maybeSingle<{ user_id: string }>();

  if (error) {
    throw new Error(`Unable to load the identity link: ${error.message}`);
  }

  return data ? { userId: data.user_id } : null;
}

export async function setPersonLink({
  workspaceId,
  entityRecordId,
  userId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityRecordId: string;
  userId: string;
  supabase?: SupabaseServerClient;
}): Promise<void> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("set_person_link_authorized", {
    p_workspace_id: workspaceId,
    p_entity_record_id: entityRecordId,
    p_user_id: userId,
  });

  if (error) {
    throw new Error(`Unable to link this record: ${error.message}`);
  }
}

export async function listUnlinkedWorkspaceMemberIdentities({
  workspaceId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  supabase?: SupabaseServerClient;
}): Promise<WorkspaceMemberIdentity[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const [identities, linkedRows] = await Promise.all([
    listWorkspaceMemberIdentities({ workspaceId, supabase }),
    supabase
      .from("entity_record_person_links")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .returns<Array<{ user_id: string }>>(),
  ]);

  if (linkedRows.error) {
    throw new Error(`Unable to load existing identity links: ${linkedRows.error.message}`);
  }

  const linkedUserIds = new Set((linkedRows.data ?? []).map((row) => row.user_id));
  return identities.filter((identity) => !linkedUserIds.has(identity.userId));
}

export async function removePersonLink({
  workspaceId,
  entityRecordId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityRecordId: string;
  supabase?: SupabaseServerClient;
}): Promise<void> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("remove_person_link_authorized", {
    p_workspace_id: workspaceId,
    p_entity_record_id: entityRecordId,
  });

  if (error) {
    throw new Error(`Unable to unlink this record: ${error.message}`);
  }
}
