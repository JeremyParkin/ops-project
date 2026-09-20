import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getEntityContext } from "./metadata-repository";
import { getEntityRecord, getRecordLabel } from "./record-repository";

// Record Work / Work Settings v1a (migrations 0146-0150). Narrow, dedicated
// wrappers around the authoritative RPCs -- mirrors the existing
// getEntityTypeSensitiveAccessConfig/getEntityTypeQualityReviewConfig
// pattern (a builder-only configuration surface, deliberately kept off the
// base EntityType type) rather than extending it.

export type EntityTypeWorkSettingsConfig = {
  workEnabled: boolean;
  assignmentFieldId: string | null;
  dueFieldId: string | null;
  statusFieldId: string | null;
  completionOptionIds: string[];
};

type EntityTypeWorkSettingsRow = {
  work_enabled: boolean;
  work_assignment_field_id: string | null;
  work_due_field_id: string | null;
  work_status_field_id: string | null;
  completion_option_ids: string[] | null;
};

// Pure snake_case -> camelCase mapping, extracted so it can be unit-tested
// without a live database or Next.js request context (createServerSupabase
// Client requires next/headers' cookies(), which only resolves inside a
// real request -- see listAssignedRecordWork's own note below for why the
// async wrappers themselves aren't unit-testable directly).
export function mapEntityTypeWorkSettingsRow(row: EntityTypeWorkSettingsRow): EntityTypeWorkSettingsConfig {
  return {
    workEnabled: row.work_enabled,
    assignmentFieldId: row.work_assignment_field_id,
    dueFieldId: row.work_due_field_id,
    statusFieldId: row.work_status_field_id,
    completionOptionIds: row.completion_option_ids ?? [],
  };
}

export async function getEntityTypeWorkSettingsConfig({
  workspaceId,
  entityTypeId,
}: {
  workspaceId: string;
  entityTypeId: string;
}): Promise<EntityTypeWorkSettingsConfig> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .rpc("get_entity_type_work_settings_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
    })
    .single<EntityTypeWorkSettingsRow>();

  if (error) {
    throw new Error(`Unable to load Work Settings configuration: ${error.message}`);
  }

  return mapEntityTypeWorkSettingsRow(data);
}

// Writes assignment/due/status/completion only -- never touches
// work_enabled. Deliberately a separate RPC/function from
// setEntityTypeWorkEnabled so a disable action can never accidentally
// rewrite or clear the mapping.
export async function setEntityTypeWorkMapping({
  workspaceId,
  entityTypeId,
  assignmentFieldId,
  dueFieldId,
  statusFieldId,
  completionOptionIds,
}: {
  workspaceId: string;
  entityTypeId: string;
  assignmentFieldId: string | null;
  dueFieldId: string | null;
  statusFieldId: string | null;
  completionOptionIds: string[];
}): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_entity_type_work_mapping_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_assignment_field_id: assignmentFieldId,
    p_due_field_id: dueFieldId,
    p_status_field_id: statusFieldId,
    p_completion_option_ids: completionOptionIds,
  });

  if (error) {
    throw new Error(error.message);
  }
}

// Writes only work_enabled. No mapping parameters at all -- see the note
// above. Enabling re-validates the currently stored mapping server-side;
// rejection messages are the RPC's own truthful reasons.
export async function setEntityTypeWorkEnabled({
  workspaceId,
  entityTypeId,
  enabled,
}: {
  workspaceId: string;
  entityTypeId: string;
  enabled: boolean;
}): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_entity_type_work_enabled_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_enabled: enabled,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export type AssignedRecordWorkItem = {
  entityTypeId: string;
  entityTypeName: string;
  recordId: string;
  recordLabel: string;
  dueDate: string | null;
  isOverdue: boolean;
  href: string;
};

type AssignedRecordWorkRow = {
  entity_type_id: string;
  entity_type_name: string;
  record_id: string;
  due_date: string | null;
  is_overdue: boolean;
};

// Pure row + already-resolved label -> UI item mapping, extracted for the
// same unit-testability reason as mapEntityTypeWorkSettingsRow above.
// Label resolution itself is necessarily async/DB-bound (getEntityContext/
// getEntityRecord/getRecordLabel), so it stays inside listAssignedRecordWork
// -- only the final shaping (including href construction) is pure.
export function mapAssignedRecordWorkRow(
  row: AssignedRecordWorkRow,
  recordLabel: string,
): AssignedRecordWorkItem {
  return {
    entityTypeId: row.entity_type_id,
    entityTypeName: row.entity_type_name,
    recordId: row.record_id,
    recordLabel,
    dueDate: row.due_date,
    isOverdue: row.is_overdue,
    href: `/entities/${row.entity_type_id}/records/${row.record_id}`,
  };
}

// Derived, not materialized: one bounded RPC call, current user's own
// assignments only (resolved server-side, impersonation-aware, via
// private.current_effective_user -- never a client-supplied id), already
// filtered to work-enabled EntityTypes, active non-completed records, and
// records the caller is authorized to view (people-sensitive visibility
// re-checked inside the RPC). This function only adds what the RPC
// deliberately leaves out: a resolved record label, batched by entity type
// the same way listMyWorkItems already batches Process origin labels, so
// this reuses that established pattern rather than inventing a new one.
export async function listAssignedRecordWork({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<AssignedRecordWorkItem[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_assigned_record_work_authorized", {
    p_workspace_id: workspaceId,
  });

  if (error) {
    throw new Error(`Unable to load assigned record work: ${error.message}`);
  }

  const rows = (data ?? []) as AssignedRecordWorkRow[];

  if (rows.length === 0) {
    return [];
  }

  const entityTypeIds = [...new Set(rows.map((row) => row.entity_type_id))];
  const entityContextByTypeId = new Map(
    await Promise.all(
      entityTypeIds.map(async (entityTypeId) => {
        try {
          const context = await getEntityContext({ workspaceId, entityTypeId });
          return [entityTypeId, context] as const;
        } catch {
          return [entityTypeId, null] as const;
        }
      }),
    ),
  );

  return Promise.all(
    rows.map(async (row) => {
      const context = entityContextByTypeId.get(row.entity_type_id);
      let recordLabel = "Record";

      if (context) {
        try {
          const record = await getEntityRecord({
            workspaceId,
            entityTypeId: row.entity_type_id,
            recordId: row.record_id,
            fields: context.fields,
          });
          recordLabel = getRecordLabel({ entityType: context.entityType, fields: context.fields, record });
        } catch {
          recordLabel = "Record";
        }
      }

      return mapAssignedRecordWorkRow(row, recordLabel);
    }),
  );
}
