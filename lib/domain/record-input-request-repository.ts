import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";

export type RecordInputRequestState = "open" | "responded" | "cancelled";

export type RecordInputRequest = {
  id: string;
  workspaceId: string;
  entityTypeId: string;
  entityRecordId: string;
  originRecordCommentId: string;
  recipientUserId: string;
  recipientLabel: string;
  responseRecordCommentId?: string;
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
  state: RecordInputRequestState;
};

export type RecordInputRequestRecipientCandidate = {
  userId: string;
  email: string;
};

type RecordInputRequestRow = {
  id: string;
  workspace_id: string;
  entity_type_id: string;
  entity_record_id: string;
  origin_record_comment_id: string;
  recipient_user_id: string;
  recipient_label: string;
  response_record_comment_id: string | null;
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

function requestState(row: RecordInputRequestRow): RecordInputRequestState {
  if (row.cancelled_at) return "cancelled";
  if (row.response_record_comment_id) return "responded";
  return "open";
}

function mapRecordInputRequest(row: RecordInputRequestRow): RecordInputRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    entityTypeId: row.entity_type_id,
    entityRecordId: row.entity_record_id,
    originRecordCommentId: row.origin_record_comment_id,
    recipientUserId: row.recipient_user_id,
    recipientLabel: row.recipient_label,
    responseRecordCommentId: row.response_record_comment_id ?? undefined,
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

export async function listRecordInputRequests({
  workspaceId,
  entityTypeId,
  recordId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  supabase?: SupabaseServerClient;
}): Promise<RecordInputRequest[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("list_record_input_requests_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_entity_record_id: recordId,
    p_limit: 100,
  });

  if (error) {
    throw new Error(`Unable to load input requests: ${error.message}`);
  }

  return ((data ?? []) as RecordInputRequestRow[]).map(mapRecordInputRequest);
}

export async function listRecordInputRequestRecipientCandidates({
  workspaceId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  supabase?: SupabaseServerClient;
}): Promise<RecordInputRequestRecipientCandidate[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("list_record_input_request_recipient_candidates_authorized", {
    p_workspace_id: workspaceId,
  });

  if (error) {
    throw new Error(`Unable to load input request recipients: ${error.message}`);
  }

  return ((data ?? []) as RecipientCandidateRow[]).map((row) => ({
    userId: row.user_id,
    email: row.email,
  }));
}

export async function createRecordInputRequest({
  workspaceId,
  entityTypeId,
  recordId,
  recipientUserId,
  body,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  recipientUserId: string;
  body: string;
  supabase?: SupabaseServerClient;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("create_record_input_request_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_entity_record_id: recordId,
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

export async function respondRecordInputRequest({
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
  const { data, error } = await supabase.rpc("respond_record_input_request_authorized", {
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

export async function cancelRecordInputRequest({
  workspaceId,
  requestId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  requestId: string;
  supabase?: SupabaseServerClient;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("cancel_record_input_request_authorized", {
    p_workspace_id: workspaceId,
    p_request_id: requestId,
  });

  if (error) {
    throw new Error(`Unable to cancel request: ${error.message}`);
  }
}
