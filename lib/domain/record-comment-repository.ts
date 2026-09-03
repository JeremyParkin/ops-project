import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";

export type RecordComment = {
  id: string;
  workspaceId: string;
  entityTypeId: string;
  entityRecordId: string;
  body?: string;
  authorUserId: string;
  authorLabel: string;
  realActorUserId?: string;
  realActorLabel?: string;
  createdAt: string;
  tombstonedAt?: string;
  tombstonedByUserId?: string;
  tombstonedByLabel?: string;
  tombstonedByRealActorUserId?: string;
  tombstonedByRealActorLabel?: string;
};

type RecordCommentRow = {
  id: string;
  workspace_id: string;
  entity_type_id: string;
  entity_record_id: string;
  body: string | null;
  author_user_id: string;
  author_label: string;
  real_actor_user_id: string | null;
  real_actor_label: string | null;
  created_at: string;
  tombstoned_at: string | null;
  tombstoned_by_user_id: string | null;
  tombstoned_by_label: string | null;
  tombstoned_by_real_actor_user_id: string | null;
  tombstoned_by_real_actor_label: string | null;
};

function mapRecordComment(row: RecordCommentRow): RecordComment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    entityTypeId: row.entity_type_id,
    entityRecordId: row.entity_record_id,
    body: row.body ?? undefined,
    authorUserId: row.author_user_id,
    authorLabel: row.author_label,
    realActorUserId: row.real_actor_user_id ?? undefined,
    realActorLabel: row.real_actor_label ?? undefined,
    createdAt: row.created_at,
    tombstonedAt: row.tombstoned_at ?? undefined,
    tombstonedByUserId: row.tombstoned_by_user_id ?? undefined,
    tombstonedByLabel: row.tombstoned_by_label ?? undefined,
    tombstonedByRealActorUserId: row.tombstoned_by_real_actor_user_id ?? undefined,
    tombstonedByRealActorLabel: row.tombstoned_by_real_actor_label ?? undefined,
  };
}

export async function listRecordComments({
  workspaceId,
  entityTypeId,
  recordId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  supabase?: SupabaseServerClient;
}): Promise<RecordComment[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("list_record_comments_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_entity_record_id: recordId,
    p_limit: 100,
  });

  if (error) {
    throw new Error(`Unable to load record comments: ${error.message}`);
  }

  return ((data ?? []) as RecordCommentRow[]).map(mapRecordComment);
}

export async function createRecordComment({
  workspaceId,
  entityTypeId,
  recordId,
  body,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  body: string;
  supabase?: SupabaseServerClient;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("create_record_comment_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_entity_record_id: recordId,
    p_body: body,
  });

  if (error) {
    throw new Error(`Unable to add comment: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to add comment: unexpected RPC response.");
  }

  return data;
}

export async function tombstoneRecordComment({
  workspaceId,
  commentId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  commentId: string;
  supabase?: SupabaseServerClient;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("tombstone_record_comment_authorized", {
    p_workspace_id: workspaceId,
    p_comment_id: commentId,
  });

  if (error) {
    throw new Error(`Unable to remove comment: ${error.message}`);
  }
}
