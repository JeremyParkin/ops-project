import { createServerSupabaseClient } from "@/lib/supabase/server";
import type {
  WorkflowActionConfig,
  WorkflowActionType,
  WorkflowDefinition,
  WorkflowExecutionLog,
  WorkflowExecutionStatus,
  WorkflowTriggerType,
} from "./workflow-types";

type WorkflowRow = {
  id: string;
  workspace_id: string;
  name: string;
  enabled: boolean;
  trigger_type: WorkflowTriggerType;
  trigger_entity_type_id: string;
  action_type: WorkflowActionType;
  action_target_entity_type_id: string | null;
  action_config: WorkflowActionConfig;
  created_at: string;
  updated_at: string;
};

type WorkflowExecutionLogRow = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  trigger_entity_type_id: string;
  trigger_record_id: string;
  status: WorkflowExecutionStatus;
  error_message: string | null;
  result_message: string | null;
  created_record_id: string | null;
  action_entity_type_id: string | null;
  action_record_id: string | null;
  started_at: string;
  completed_at: string;
};

type CreateWorkflowInput = {
  workspaceId: string;
  name: string;
  enabled?: boolean;
  triggerType: WorkflowTriggerType;
  triggerEntityTypeId: string;
  actionType: WorkflowActionType;
  actionTargetEntityTypeId?: string;
  actionConfig: WorkflowActionConfig;
};

type UpdateWorkflowInput = CreateWorkflowInput & {
  workflowId: string;
  enabled: boolean;
};

type CreateWorkflowExecutionLogInput = {
  workspaceId: string;
  workflowId: string;
  triggerEntityTypeId: string;
  triggerRecordId: string;
  status: WorkflowExecutionStatus;
  errorMessage?: string;
  resultMessage?: string;
  createdRecordId?: string;
  actionEntityTypeId?: string;
  actionRecordId?: string;
  startedAt: string;
  completedAt: string;
};

function mapWorkflow(row: WorkflowRow): WorkflowDefinition {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    enabled: row.enabled,
    triggerType: row.trigger_type,
    triggerEntityTypeId: row.trigger_entity_type_id,
    actionType: row.action_type,
    actionTargetEntityTypeId: row.action_target_entity_type_id ?? undefined,
    actionConfig: row.action_config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkflowExecutionLog(
  row: WorkflowExecutionLogRow,
): WorkflowExecutionLog {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    triggerEntityTypeId: row.trigger_entity_type_id,
    triggerRecordId: row.trigger_record_id,
    status: row.status,
    errorMessage: row.error_message ?? undefined,
    resultMessage: row.result_message ?? undefined,
    createdRecordId: row.created_record_id ?? undefined,
    actionEntityTypeId: row.action_entity_type_id ?? undefined,
    actionRecordId: row.action_record_id ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function workflowReferencesField(
  workflow: WorkflowDefinition,
  fieldDefinitionId: string,
) {
  const templateToken = `{{field:${fieldDefinitionId}}}`;
  const watchedFieldDefinitionIds =
    workflow.actionConfig.triggerConfig?.watchedFieldDefinitionIds ?? [];

  if (watchedFieldDefinitionIds.includes(fieldDefinitionId)) {
    return true;
  }

  if (
    (workflow.actionConfig.conditions ?? []).some(
      (condition) => condition.sourceFieldDefinitionId === fieldDefinitionId,
    )
  ) {
    return true;
  }

  return workflow.actionConfig.fieldMappings.some((mapping) => {
    if (mapping.targetFieldDefinitionId === fieldDefinitionId) {
      return true;
    }

    if (
      mapping.source.type === "source_field" &&
      mapping.source.sourceFieldDefinitionId === fieldDefinitionId
    ) {
      return true;
    }

    return (
      mapping.source.type === "template" &&
      mapping.source.template.includes(templateToken)
    );
  });
}

export function countWorkflowReferencesByFieldId({
  workflows,
  fieldDefinitionIds,
}: {
  workflows: WorkflowDefinition[];
  fieldDefinitionIds: string[];
}) {
  return Object.fromEntries(
    fieldDefinitionIds.map((fieldDefinitionId) => [
      fieldDefinitionId,
      workflows.filter((workflow) =>
        workflowReferencesField(workflow, fieldDefinitionId),
      ).length,
    ]),
  );
}

export async function listWorkflows({ workspaceId }: { workspaceId: string }) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true })
    .returns<WorkflowRow[]>();

  if (error) {
    throw new Error(`Unable to load workflows: ${error.message}`);
  }

  return data.map(mapWorkflow);
}

export async function getWorkflow({
  workspaceId,
  workflowId,
}: {
  workspaceId: string;
  workflowId: string;
}) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", workflowId)
    .single<WorkflowRow>();

  if (error) {
    throw new Error(`Unable to load workflow: ${error.message}`);
  }

  return mapWorkflow(data);
}

export async function listEnabledWorkflowsForTrigger({
  workspaceId,
  triggerType,
  triggerEntityTypeId,
}: {
  workspaceId: string;
  triggerType: WorkflowTriggerType;
  triggerEntityTypeId: string;
}) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("trigger_type", triggerType)
    .eq("trigger_entity_type_id", triggerEntityTypeId)
    .eq("enabled", true)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .returns<WorkflowRow[]>();

  if (error) {
    throw new Error(`Unable to load matching workflows: ${error.message}`);
  }

  return data.map(mapWorkflow);
}

export async function listEnabledRecordCreatedWorkflows({
  workspaceId,
  triggerEntityTypeId,
}: {
  workspaceId: string;
  triggerEntityTypeId: string;
}) {
  return listEnabledWorkflowsForTrigger({
    workspaceId,
    triggerType: "record_created",
    triggerEntityTypeId,
  });
}

export async function createWorkflowDefinition({
  workspaceId,
  name,
  enabled = true,
  triggerType,
  triggerEntityTypeId,
  actionType,
  actionTargetEntityTypeId,
  actionConfig,
}: CreateWorkflowInput) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .insert({
      workspace_id: workspaceId,
      name,
      enabled,
      trigger_type: triggerType,
      trigger_entity_type_id: triggerEntityTypeId,
      action_type: actionType,
      action_target_entity_type_id: actionTargetEntityTypeId ?? null,
      action_config: actionConfig,
    })
    .select("id")
    .single<{ id: string }>();

  if (error) {
    throw new Error(`Unable to create workflow: ${error.message}`);
  }

  return data.id;
}

export async function updateWorkflowDefinition({
  workspaceId,
  workflowId,
  name,
  enabled,
  triggerType,
  triggerEntityTypeId,
  actionType,
  actionTargetEntityTypeId,
  actionConfig,
}: UpdateWorkflowInput) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .update({
      name,
      enabled,
      trigger_type: triggerType,
      trigger_entity_type_id: triggerEntityTypeId,
      action_type: actionType,
      action_target_entity_type_id: actionTargetEntityTypeId ?? null,
      action_config: actionConfig,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", workflowId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to update workflow: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to update workflow: workflow not found.");
  }
}

export async function setWorkflowEnabled({
  workspaceId,
  workflowId,
  enabled,
}: {
  workspaceId: string;
  workflowId: string;
  enabled: boolean;
}) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .update({
      enabled,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", workflowId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to update workflow status: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to update workflow status: workflow not found.");
  }
}

export async function deleteWorkflowDefinition({
  workspaceId,
  workflowId,
}: {
  workspaceId: string;
  workflowId: string;
}) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("id", workflowId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to delete workflow: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to delete workflow: workflow not found.");
  }
}

export async function createWorkflowExecutionLog({
  workspaceId,
  workflowId,
  triggerEntityTypeId,
  triggerRecordId,
  status,
  errorMessage,
  resultMessage,
  createdRecordId,
  actionEntityTypeId,
  actionRecordId,
  startedAt,
  completedAt,
}: CreateWorkflowExecutionLogInput) {
  const supabase = createServerSupabaseClient();
  const { error } = await supabase.from("workflow_execution_logs").insert({
    workspace_id: workspaceId,
    workflow_id: workflowId,
    trigger_entity_type_id: triggerEntityTypeId,
    trigger_record_id: triggerRecordId,
    status,
    error_message: errorMessage ?? null,
    result_message: resultMessage ?? null,
    created_record_id: createdRecordId ?? null,
    action_entity_type_id: actionEntityTypeId ?? null,
    action_record_id: actionRecordId ?? null,
    started_at: startedAt,
    completed_at: completedAt,
  });

  if (error) {
    throw new Error(`Unable to create workflow execution log: ${error.message}`);
  }
}

export async function listRecentWorkflowExecutionLogs({
  workspaceId,
  limit = 20,
}: {
  workspaceId: string;
  limit?: number;
}) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflow_execution_logs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false })
    .limit(limit)
    .returns<WorkflowExecutionLogRow[]>();

  if (error) {
    throw new Error(`Unable to load workflow execution logs: ${error.message}`);
  }

  return data.map(mapWorkflowExecutionLog);
}
