import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";

export type ProcessStepRunInputRequestState = "open" | "responded" | "cancelled";

export type ProcessStepRunInputRequest = {
  id: string;
  workspaceId: string;
  processRunId: string;
  processStepRunId: string;
  originProcessStepRunCommentId: string;
  recipientUserId: string;
  recipientLabel: string;
  responseProcessStepRunCommentId?: string;
  cancelledAt?: string;
  cancelledByUserId?: string;
  cancelledByRealActorUserId?: string;
  originAuthorUserId: string;
  originAuthorLabel: string;
  originRealActorUserId?: string;
  originRealActorLabel?: string;
  originCreatedAt: string;
  originTombstonedAt?: string;
  responseAuthorUserId?: string;
  responseAuthorLabel?: string;
  responseRealActorUserId?: string;
  responseRealActorLabel?: string;
  responseCreatedAt?: string;
  responseTombstonedAt?: string;
  state: ProcessStepRunInputRequestState;
};

export type ProcessStepRunInputRequestRecipientCandidate = {
  userId: string;
  email: string;
};

type ProcessStepRunInputRequestRow = {
  id: string;
  workspace_id: string;
  process_run_id: string;
  process_step_run_id: string;
  origin_process_step_run_comment_id: string;
  recipient_user_id: string;
  recipient_label: string;
  response_process_step_run_comment_id: string | null;
  cancelled_at: string | null;
  cancelled_by_user_id: string | null;
  cancelled_by_real_actor_user_id: string | null;
  origin_author_user_id: string;
  origin_author_label: string;
  origin_real_actor_user_id: string | null;
  origin_real_actor_label: string | null;
  origin_created_at: string;
  origin_tombstoned_at: string | null;
  response_author_user_id: string | null;
  response_author_label: string | null;
  response_real_actor_user_id: string | null;
  response_real_actor_label: string | null;
  response_created_at: string | null;
  response_tombstoned_at: string | null;
};

type RecipientCandidateRow = {
  user_id: string;
  email: string;
};

function requestState(row: ProcessStepRunInputRequestRow): ProcessStepRunInputRequestState {
  if (row.cancelled_at) return "cancelled";
  if (row.response_process_step_run_comment_id) return "responded";
  return "open";
}

function mapProcessStepRunInputRequest(row: ProcessStepRunInputRequestRow): ProcessStepRunInputRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    processRunId: row.process_run_id,
    processStepRunId: row.process_step_run_id,
    originProcessStepRunCommentId: row.origin_process_step_run_comment_id,
    recipientUserId: row.recipient_user_id,
    recipientLabel: row.recipient_label,
    responseProcessStepRunCommentId: row.response_process_step_run_comment_id ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    cancelledByUserId: row.cancelled_by_user_id ?? undefined,
    cancelledByRealActorUserId: row.cancelled_by_real_actor_user_id ?? undefined,
    originAuthorUserId: row.origin_author_user_id,
    originAuthorLabel: row.origin_author_label,
    originRealActorUserId: row.origin_real_actor_user_id ?? undefined,
    originRealActorLabel: row.origin_real_actor_label ?? undefined,
    originCreatedAt: row.origin_created_at,
    originTombstonedAt: row.origin_tombstoned_at ?? undefined,
    responseAuthorUserId: row.response_author_user_id ?? undefined,
    responseAuthorLabel: row.response_author_label ?? undefined,
    responseRealActorUserId: row.response_real_actor_user_id ?? undefined,
    responseRealActorLabel: row.response_real_actor_label ?? undefined,
    responseCreatedAt: row.response_created_at ?? undefined,
    responseTombstonedAt: row.response_tombstoned_at ?? undefined,
    state: requestState(row),
  };
}

export async function listProcessStepRunInputRequests({
  workspaceId,
  processRunId,
  processStepRunId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  processRunId: string;
  processStepRunId: string;
  supabase?: SupabaseServerClient;
}): Promise<ProcessStepRunInputRequest[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("list_process_step_run_input_requests_authorized", {
    p_workspace_id: workspaceId,
    p_process_run_id: processRunId,
    p_process_step_run_id: processStepRunId,
    p_limit: 100,
  });

  if (error) {
    throw new Error(`Unable to load input requests: ${error.message}`);
  }

  return ((data ?? []) as ProcessStepRunInputRequestRow[]).map(mapProcessStepRunInputRequest);
}

export async function listProcessStepRunInputRequestRecipientCandidates({
  workspaceId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  supabase?: SupabaseServerClient;
}): Promise<ProcessStepRunInputRequestRecipientCandidate[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc(
    "list_process_step_run_input_request_recipients_authorized",
    { p_workspace_id: workspaceId },
  );

  if (error) {
    throw new Error(`Unable to load input request recipients: ${error.message}`);
  }

  return ((data ?? []) as RecipientCandidateRow[]).map((row) => ({
    userId: row.user_id,
    email: row.email,
  }));
}

export async function createProcessStepRunInputRequest({
  workspaceId,
  processRunId,
  processStepRunId,
  recipientUserId,
  body,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  processRunId: string;
  processStepRunId: string;
  recipientUserId: string;
  body: string;
  supabase?: SupabaseServerClient;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("create_process_step_run_input_request_authorized", {
    p_workspace_id: workspaceId,
    p_process_run_id: processRunId,
    p_process_step_run_id: processStepRunId,
    p_recipient_user_id: recipientUserId,
    p_body: body,
  });

  if (error) {
    throw new Error(`Unable to request input: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to request input: unexpected RPC response.");
  }

  return data;
}

export async function respondProcessStepRunInputRequest({
  workspaceId,
  requestId,
  body,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  requestId: string;
  body: string;
  supabase?: SupabaseServerClient;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("respond_process_step_run_input_request_authorized", {
    p_workspace_id: workspaceId,
    p_request_id: requestId,
    p_body: body,
  });

  if (error) {
    throw new Error(`Unable to respond to request: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to respond to request: unexpected RPC response.");
  }

  return data;
}

export async function cancelProcessStepRunInputRequest({
  workspaceId,
  requestId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  requestId: string;
  supabase?: SupabaseServerClient;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("cancel_process_step_run_input_request_authorized", {
    p_workspace_id: workspaceId,
    p_request_id: requestId,
  });

  if (error) {
    throw new Error(`Unable to cancel request: ${error.message}`);
  }
}
