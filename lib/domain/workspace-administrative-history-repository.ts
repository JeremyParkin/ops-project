import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";

export const ADMINISTRATIVE_HISTORY_DEFAULT_LIMIT = 50;
export const ADMINISTRATIVE_HISTORY_MAX_LIMIT = 100;

export type WorkspaceAdministrativeHistoryFilters = {
  category?: string;
  eventType?: string;
  actorUserId?: string;
  subjectKind?: string;
  subjectId?: string;
  startAt?: string;
  endAt?: string;
};

export type WorkspaceAdministrativeHistoryCursor = {
  occurredAt: string;
  sourceFamily: string;
  sourceEventId: string;
};

export type WorkspaceAdministrativeHistoryEvent = {
  eventId: string;
  sourceFamily: string;
  sourceEventId: string;
  occurredAt: string;
  eventType: string;
  category: string;
  subjectKind: string | null;
  subjectId: string | null;
  subjectLabel: string | null;
  actorUserId: string | null;
  effectiveUserId: string | null;
  realUserId: string | null;
  authorityKind: string | null;
  summaryKey: string;
  details: Record<string, unknown>;
  correlationId: string | null;
};

type WorkspaceAdministrativeHistoryRpcRow = {
  event_id: string;
  source_family: string;
  source_event_id: string;
  occurred_at: string;
  event_type: string;
  category: string;
  subject_kind: string | null;
  subject_id: string | null;
  subject_label: string | null;
  actor_user_id: string | null;
  effective_user_id: string | null;
  real_user_id: string | null;
  authority_kind: string | null;
  summary_key: string;
  details: Record<string, unknown>;
  correlation_id: string | null;
};

function requiredRpcValue(row: WorkspaceAdministrativeHistoryRpcRow, key: "event_id" | "source_event_id" | "event_type" | "summary_key") {
  const value = row[key];
  if (!value) throw new Error(`Administrative history RPC returned an invalid ${key}`);
  return value;
}

export function mapWorkspaceAdministrativeHistoryRpcRow(
  row: WorkspaceAdministrativeHistoryRpcRow,
): WorkspaceAdministrativeHistoryEvent {
  return {
    eventId: requiredRpcValue(row, "event_id"),
    sourceFamily: row.source_family,
    sourceEventId: requiredRpcValue(row, "source_event_id"),
    occurredAt: row.occurred_at,
    eventType: requiredRpcValue(row, "event_type"),
    category: row.category,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    subjectLabel: row.subject_label,
    actorUserId: row.actor_user_id,
    effectiveUserId: row.effective_user_id,
    realUserId: row.real_user_id,
    authorityKind: row.authority_kind,
    summaryKey: requiredRpcValue(row, "summary_key"),
    details: row.details,
    correlationId: row.correlation_id,
  };
}

export async function listWorkspaceAdministrativeHistory({
  workspaceId,
  limit = ADMINISTRATIVE_HISTORY_DEFAULT_LIMIT,
  cursor,
  filters,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  limit?: number;
  cursor?: WorkspaceAdministrativeHistoryCursor;
  filters?: WorkspaceAdministrativeHistoryFilters;
  supabase?: SupabaseServerClient;
}): Promise<{
  events: WorkspaceAdministrativeHistoryEvent[];
  nextCursor: WorkspaceAdministrativeHistoryCursor | null;
}> {
  if (!Number.isInteger(limit) || limit < 1 || limit > ADMINISTRATIVE_HISTORY_MAX_LIMIT) {
    throw new Error(`Administrative history limit must be between 1 and ${ADMINISTRATIVE_HISTORY_MAX_LIMIT}`);
  }

  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("list_workspace_administrative_history_authorized", {
    p_workspace_id: workspaceId,
    p_limit: limit,
    p_after_occurred_at: cursor?.occurredAt ?? null,
    p_after_source_family: cursor?.sourceFamily ?? null,
    p_after_source_event_id: cursor?.sourceEventId ?? null,
    p_category: filters?.category ?? null,
    p_event_type: filters?.eventType ?? null,
    p_actor_user_id: filters?.actorUserId ?? null,
    p_subject_kind: filters?.subjectKind ?? null,
    p_subject_id: filters?.subjectId ?? null,
    p_start_at: filters?.startAt ?? null,
    p_end_at: filters?.endAt ?? null,
  });

  if (error) throw new Error(`Unable to load Workspace Administrative History: ${error.message}`);

  const events = (data as WorkspaceAdministrativeHistoryRpcRow[] | null ?? []).map(mapWorkspaceAdministrativeHistoryRpcRow);
  const last = events.at(-1);
  return {
    events,
    nextCursor: events.length === limit && last
      ? { occurredAt: last.occurredAt, sourceFamily: last.sourceFamily, sourceEventId: last.sourceEventId }
      : null,
  };
}
