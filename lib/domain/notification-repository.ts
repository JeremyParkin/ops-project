import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";
import { getEntityContext } from "./metadata-repository";
import { getRecordLabel, listEntityRecords } from "./record-repository";
import type { NotificationEventType, WorkspaceNotification } from "./notification-types";

const NOTIFICATION_LIST_LIMIT = 50;

type NotificationRow = {
  id: string;
  workspace_id: string;
  recipient_user_id: string;
  event_type: NotificationEventType;
  process_template_id: string | null;
  process_run_id: string | null;
  process_step_run_id: string | null;
  record_comment_id: string | null;
  process_step_run_comment_id: string | null;
  record_input_request_id: string | null;
  process_step_run_input_request_id: string | null;
  entity_type_id: string | null;
  entity_record_id: string | null;
  title: string;
  destination_href: string;
  created_at: string;
  read_at: string | null;
};

function mapNotification(row: NotificationRow): WorkspaceNotification {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    recipientUserId: row.recipient_user_id,
    eventType: row.event_type,
    processTemplateId: row.process_template_id ?? undefined,
    processRunId: row.process_run_id ?? undefined,
    processStepRunId: row.process_step_run_id ?? undefined,
    recordCommentId: row.record_comment_id ?? undefined,
    processStepRunCommentId: row.process_step_run_comment_id ?? undefined,
    recordInputRequestId: row.record_input_request_id ?? undefined,
    processStepRunInputRequestId: row.process_step_run_input_request_id ?? undefined,
    entityTypeId: row.entity_type_id ?? undefined,
    entityRecordId: row.entity_record_id ?? undefined,
    title: row.title,
    destinationHref: row.destination_href,
    createdAt: row.created_at,
    readAt: row.read_at ?? undefined,
  };
}

// Notifications store only the cheap, already-snapshotted part of their
// content (step name + event-type phrasing) at creation time in SQL --
// resolving an origin record's current display label requires the same
// display-field-then-first-text-field-then-id logic getRecordLabel already
// owns, which has no SQL equivalent anywhere in this codebase and shouldn't
// gain a second, drift-prone implementation there. This resolves it here
// instead, batched by entity type (same N+1-avoidance shape as
// getRelationLookups' restrictToCurrentRecordValues mode and the CSV
// import's resolveRelationValues) rather than one lookup per notification.
async function resolveNotificationContext(
  workspaceId: string,
  notifications: WorkspaceNotification[],
  supabase: SupabaseServerClient,
): Promise<WorkspaceNotification[]> {
  const runIds = [...new Set(notifications.map((n) => n.processRunId).filter((id): id is string => Boolean(id)))];
  const processTemplateNameByRunId = new Map<string, string>();

  if (runIds.length > 0) {
    const { data: runRows, error: runError } = await supabase
      .from("process_runs")
      .select("id, process_template_name")
      .eq("workspace_id", workspaceId)
      .in("id", runIds)
      .returns<{ id: string; process_template_name: string }[]>();

    if (runError) {
      throw new Error(`Unable to load process run context: ${runError.message}`);
    }

    (runRows ?? []).forEach((row) => processTemplateNameByRunId.set(row.id, row.process_template_name));
  }

  const recordIdsByEntityTypeId = new Map<string, Set<string>>();
  notifications.forEach((n) => {
    if (!n.entityTypeId || !n.entityRecordId) return;
    const set = recordIdsByEntityTypeId.get(n.entityTypeId) ?? new Set<string>();
    set.add(n.entityRecordId);
    recordIdsByEntityTypeId.set(n.entityTypeId, set);
  });

  const labelByEntityRecordKey = new Map<string, { label: string; entityTypeName: string }>();

  await Promise.all(
    [...recordIdsByEntityTypeId.entries()].map(async ([entityTypeId, recordIdSet]) => {
      const { entityType, fields } = await getEntityContext({ workspaceId, entityTypeId, supabase });
      const records = await listEntityRecords({
        workspaceId,
        entityTypeId,
        fields,
        includeArchived: true,
        ids: [...recordIdSet],
        supabase,
      });

      records.forEach((record) => {
        labelByEntityRecordKey.set(`${entityTypeId}:${record.id}`, {
          label: getRecordLabel({ entityType, fields, record }),
          entityTypeName: entityType.name,
        });
      });
    }),
  );

  return notifications.map((n) => {
    const resolved =
      n.entityTypeId && n.entityRecordId
        ? labelByEntityRecordKey.get(`${n.entityTypeId}:${n.entityRecordId}`)
        : undefined;

    return {
      ...n,
      context: {
        processTemplateName: n.processRunId ? processTemplateNameByRunId.get(n.processRunId) : undefined,
        originLabel: resolved?.label,
        originEntityTypeName: resolved?.entityTypeName,
      },
    };
  });
}

export async function listMyNotifications({
  workspaceId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  supabase?: SupabaseServerClient;
}): Promise<WorkspaceNotification[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(NOTIFICATION_LIST_LIMIT)
    .returns<NotificationRow[]>();

  if (error) {
    throw new Error(`Unable to load notifications: ${error.message}`);
  }

  const notifications = (data ?? []).map(mapNotification);

  return resolveNotificationContext(workspaceId, notifications, supabase);
}

export async function getUnreadNotificationCount({
  workspaceId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  supabase?: SupabaseServerClient;
}): Promise<number> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .is("read_at", null);

  if (error) {
    throw new Error(`Unable to load unread notification count: ${error.message}`);
  }

  return count ?? 0;
}

export async function markNotificationRead({
  workspaceId,
  notificationId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  notificationId: string;
  supabase?: SupabaseServerClient;
}): Promise<void> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("mark_notification_read_authorized", {
    p_workspace_id: workspaceId,
    p_notification_id: notificationId,
  });

  if (error) {
    throw new Error(`Unable to mark notification read: ${error.message}`);
  }
}

export async function markAllNotificationsRead({
  workspaceId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  supabase?: SupabaseServerClient;
}): Promise<void> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("mark_all_notifications_read_authorized", {
    p_workspace_id: workspaceId,
  });

  if (error) {
    throw new Error(`Unable to mark notifications read: ${error.message}`);
  }
}
