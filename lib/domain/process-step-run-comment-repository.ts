import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";

export type ProcessStepRunComment = {
  id: string;
  workspaceId: string;
  processRunId: string;
  processStepRunId: string;
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

export type ProcessStepRunCommentMentionCandidate = {
  userId: string;
  email: string;
};

type ProcessStepRunCommentRow = {
  id: string;
  workspace_id: string;
  process_run_id: string;
  process_step_run_id: string;
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

type WorkspaceMemberIdentityRow = {
  user_id: string;
  email: string;
};

function mapProcessStepRunComment(row: ProcessStepRunCommentRow): ProcessStepRunComment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    processRunId: row.process_run_id,
    processStepRunId: row.process_step_run_id,
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

export async function listProcessStepRunComments({
  workspaceId,
  processRunId,
  processStepRunId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  processRunId: string;
  processStepRunId: string;
  supabase?: SupabaseServerClient;
}): Promise<ProcessStepRunComment[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("list_process_step_run_comments_authorized", {
    p_workspace_id: workspaceId,
    p_process_run_id: processRunId,
    p_process_step_run_id: processStepRunId,
    p_limit: 100,
  });

  if (error) {
    throw new Error(`Unable to load process step comments: ${error.message}`);
  }

  return ((data ?? []) as ProcessStepRunCommentRow[]).map(mapProcessStepRunComment);
}

export async function createProcessStepRunCommentWithMentions({
  workspaceId,
  processRunId,
  processStepRunId,
  body,
  mentionedUserIds,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  processRunId: string;
  processStepRunId: string;
  body: string;
  mentionedUserIds: string[];
  supabase?: SupabaseServerClient;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("create_process_step_run_comment_with_mentions_authorized", {
    p_workspace_id: workspaceId,
    p_process_run_id: processRunId,
    p_process_step_run_id: processStepRunId,
    p_body: body,
    p_mentioned_user_ids: [...new Set(mentionedUserIds)],
  });

  if (error) {
    throw new Error(`Unable to add comment: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to add comment: unexpected RPC response.");
  }

  return data;
}

export async function tombstoneProcessStepRunComment({
  workspaceId,
  commentId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  commentId: string;
  supabase?: SupabaseServerClient;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("tombstone_process_step_run_comment_authorized", {
    p_workspace_id: workspaceId,
    p_comment_id: commentId,
  });

  if (error) {
    throw new Error(`Unable to remove comment: ${error.message}`);
  }
}

export async function listProcessStepRunCommentMentionCandidates({
  workspaceId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  supabase?: SupabaseServerClient;
}): Promise<ProcessStepRunCommentMentionCandidate[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("list_workspace_member_identities_authorized", {
    p_workspace_id: workspaceId,
  });

  if (error) {
    throw new Error(`Unable to load mention candidates: ${error.message}`);
  }

  return ((data ?? []) as WorkspaceMemberIdentityRow[]).map((row) => ({
    userId: row.user_id,
    email: row.email,
  }));
}
