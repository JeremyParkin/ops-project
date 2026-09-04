import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";
import type { ActivityEventType, RecordActivityEvent } from "./activity-types";

const RECORD_ACTIVITY_LIMIT = 20;

type RecordActivityRow = {
  id: string;
  event_type: ActivityEventType;
  created_at: string;
  actor_user_id: string | null;
  actor_label: string | null;
  process_run_id: string | null;
  process_run_name: string | null;
  process_step_run_id: string | null;
  step_name: string | null;
  assignee_label: string | null;
  approval_outcome_label: string | null;
  is_recurrence_started: boolean;
  cancellation_reason: string | null;
  from_assignee_label: string | null;
  to_assignee_label: string | null;
};

// Events created within the same canonical transaction share the exact same
// `created_at` -- Postgres `now()` is frozen per-transaction, not per-
// statement -- so `order by created_at desc` alone leaves same-instant rows
// in an undefined, potentially unstable order. Every canonical function
// that emits a "trigger" event (process_started, approval_decided) may,
// later in that same transaction, activate a next step -- creating a
// step_assigned (or, if nothing more is left to run, a process_completed)
// as its direct, causally-later consequence. A trigger and its own
// consequence never share a transaction with another trigger or another
// consequence, so a flat two-tier ranking is enough to always put the
// consequence above the trigger it followed in the newest-first list,
// without a schema change or touching the read RPC's own ordering.
const EVENT_CAUSAL_TIER: Record<ActivityEventType, number> = {
  process_started: 0,
  approval_decided: 0,
  step_assigned: 1,
  process_completed: 1,
  // cancel_process_run_authorized emits exactly one workspace_events row per
  // transaction -- there is no same-timestamp "consequence" event it could
  // ever tie against, so its tier value is arbitrary; 0 groups it with the
  // other standalone/trigger-shaped events for consistency.
  process_cancelled: 0,
  // reassign_process_step_run_authorized emits exactly one workspace_events
  // row per transaction, same reasoning as process_cancelled above.
  step_reassigned: 0,
};

export function compareNewestFirstWithStableTies(a: RecordActivityEvent, b: RecordActivityEvent): number {
  const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (timeDiff !== 0) return timeDiff;
  return EVENT_CAUSAL_TIER[b.eventType] - EVENT_CAUSAL_TIER[a.eventType];
}

function mapRow(row: RecordActivityRow): RecordActivityEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    createdAt: row.created_at,
    actorUserId: row.actor_user_id ?? undefined,
    actorLabel: row.actor_label ?? undefined,
    processRunId: row.process_run_id ?? undefined,
    processRunName: row.process_run_name ?? undefined,
    processStepRunId: row.process_step_run_id ?? undefined,
    stepName: row.step_name ?? undefined,
    assigneeLabel: row.assignee_label ?? undefined,
    approvalOutcomeLabel: row.approval_outcome_label ?? undefined,
    isRecurrenceStarted: row.is_recurrence_started,
    cancellationReason: row.cancellation_reason ?? undefined,
    fromAssigneeLabel: row.from_assignee_label ?? undefined,
    toAssigneeLabel: row.to_assignee_label ?? undefined,
  };
}

// Record-context Activity only -- the RPC itself enforces the same
// workspace-membership bar an ordinary record read already requires (see
// migration 0065) and is the only read path into workspace_events; there is
// no general events feed. Newest-first, DB-limited to 20, no fetch-all.
export async function listRecordActivity({
  workspaceId,
  entityTypeId,
  recordId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  supabase?: SupabaseServerClient;
}): Promise<RecordActivityEvent[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("list_record_activity_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_entity_record_id: recordId,
    p_limit: RECORD_ACTIVITY_LIMIT,
  });

  if (error) {
    throw new Error(`Unable to load record activity: ${error.message}`);
  }

  return ((data ?? []) as RecordActivityRow[]).map(mapRow).sort(compareNewestFirstWithStableTies);
}
