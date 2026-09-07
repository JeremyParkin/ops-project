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

  const events = (data ?? []) as WorkspaceAdministrativeHistoryEvent[];
  const last = events.at(-1);
  return {
    events,
    nextCursor: events.length === limit && last
      ? { occurredAt: last.occurredAt, sourceFamily: last.sourceFamily, sourceEventId: last.sourceEventId }
      : null,
  };
}
