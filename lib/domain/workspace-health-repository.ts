import { createServerSupabaseClient } from "@/lib/supabase/server";

export const workspaceHealthCheckTypes = [
  "no_active_fields",
  "missing_display_field",
  "recurrence_unreachable",
  "stuck_process_run",
  "deactivated_assignee",
] as const;

export type WorkspaceHealthCheckType = (typeof workspaceHealthCheckTypes)[number];
export type WorkspaceHealthSeverity = "needs_attention" | "worth_reviewing";

export type WorkspaceHealthFinding = {
  findingId: string;
  checkType: WorkspaceHealthCheckType;
  severity: WorkspaceHealthSeverity;
  title: string;
  detail: string;
  entityTypeId?: string;
  entityTypeName?: string;
  recordId?: string;
  recordLabel?: string;
  processRunId?: string;
  processTemplateName?: string;
  processStepRunId?: string;
  memberEmail?: string;
  fixHref: string;
};

type WorkspaceHealthFindingRow = {
  finding_id: string;
  check_type: WorkspaceHealthCheckType;
  severity: WorkspaceHealthSeverity;
  title: string;
  detail: string;
  entity_type_id: string | null;
  entity_type_name: string | null;
  record_id: string | null;
  record_label: string | null;
  process_run_id: string | null;
  process_template_name: string | null;
  process_step_run_id: string | null;
  member_email: string | null;
};

// Fix links are a presentation concern -- the RPC returns raw ids/labels
// only, this is the sole place that turns a finding into a destination.
function fixHrefFor(row: WorkspaceHealthFindingRow): string {
  switch (row.check_type) {
    case "no_active_fields":
    case "missing_display_field":
      return `/entities/${row.entity_type_id}?manage=true`;
    case "recurrence_unreachable":
      return `/entities/${row.entity_type_id}/records/${row.record_id}`;
    case "stuck_process_run":
    case "deactivated_assignee":
      return `/process-runs/${row.process_run_id}`;
  }
}

export async function listWorkspaceHealthFindings({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<WorkspaceHealthFinding[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_workspace_health_findings_authorized", {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as WorkspaceHealthFindingRow[]).map((row) => ({
    findingId: row.finding_id,
    checkType: row.check_type,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    entityTypeId: row.entity_type_id ?? undefined,
    entityTypeName: row.entity_type_name ?? undefined,
    recordId: row.record_id ?? undefined,
    recordLabel: row.record_label ?? undefined,
    processRunId: row.process_run_id ?? undefined,
    processTemplateName: row.process_template_name ?? undefined,
    processStepRunId: row.process_step_run_id ?? undefined,
    memberEmail: row.member_email ?? undefined,
    fixHref: fixHrefFor(row),
  }));
}
