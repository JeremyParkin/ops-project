import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";
import type { ProcessRecurrenceRule, ProcessRecurrenceRuleInput } from "./recurrence-types";

type RecurrenceRuleRow = {
  id: string;
  workspace_id: string;
  process_template_id: string;
  origin_entity_type_id: string;
  origin_record_id: string;
  frequency: "daily" | "weekly" | "monthly";
  interval_count: number;
  day_of_week: number | null;
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
  time_of_day: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

function mapRecurrenceRule(row: RecurrenceRuleRow): ProcessRecurrenceRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    processTemplateId: row.process_template_id,
    originEntityTypeId: row.origin_entity_type_id,
    originRecordId: row.origin_record_id,
    frequency: row.frequency,
    intervalCount: row.interval_count,
    dayOfWeek: row.day_of_week ?? undefined,
    dayOfMonth: row.day_of_month ?? undefined,
    startDate: row.start_date,
    endDate: row.end_date ?? undefined,
    // Postgres returns `time` values with seconds (HH:MM:SS); the form only
    // ever collects/displays HH:MM, so trim it at the boundary rather than
    // threading a formatting concern through every caller.
    timeOfDay: row.time_of_day.slice(0, 5),
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRecurrenceRulesForOrigin({
  workspaceId,
  originEntityTypeId,
  originRecordId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  originEntityTypeId: string;
  originRecordId: string;
  supabase?: SupabaseServerClient;
}): Promise<ProcessRecurrenceRule[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase
    .from("process_recurrence_rules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("origin_entity_type_id", originEntityTypeId)
    .eq("origin_record_id", originRecordId)
    .returns<RecurrenceRuleRow[]>();

  if (error) {
    throw new Error(`Unable to load recurrence rules: ${error.message}`);
  }

  return (data ?? []).map(mapRecurrenceRule);
}

export async function createRecurrenceRule({
  workspaceId,
  processTemplateId,
  originEntityTypeId,
  originRecordId,
  input,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  processTemplateId: string;
  originEntityTypeId: string;
  originRecordId: string;
  input: ProcessRecurrenceRuleInput;
  supabase?: SupabaseServerClient;
}): Promise<string> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("create_process_recurrence_rule_authorized", {
    p_workspace_id: workspaceId,
    p_process_template_id: processTemplateId,
    p_origin_entity_type_id: originEntityTypeId,
    p_origin_record_id: originRecordId,
    p_frequency: input.frequency,
    p_interval_count: input.intervalCount,
    p_day_of_week: input.dayOfWeek ?? null,
    p_day_of_month: input.dayOfMonth ?? null,
    p_start_date: input.startDate,
    p_end_date: input.endDate ?? null,
    p_time_of_day: input.timeOfDay,
  });

  if (error) {
    throw new Error(`Unable to create recurrence rule: ${error.message}`);
  }

  return data as string;
}

export async function updateRecurrenceRule({
  workspaceId,
  recurrenceRuleId,
  input,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  recurrenceRuleId: string;
  input: ProcessRecurrenceRuleInput;
  supabase?: SupabaseServerClient;
}): Promise<void> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("update_process_recurrence_rule_authorized", {
    p_workspace_id: workspaceId,
    p_recurrence_rule_id: recurrenceRuleId,
    p_frequency: input.frequency,
    p_interval_count: input.intervalCount,
    p_day_of_week: input.dayOfWeek ?? null,
    p_day_of_month: input.dayOfMonth ?? null,
    p_start_date: input.startDate,
    p_end_date: input.endDate ?? null,
    p_time_of_day: input.timeOfDay,
  });

  if (error) {
    throw new Error(`Unable to update recurrence rule: ${error.message}`);
  }
}

export async function getWorkspaceTimezone({
  workspaceId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  supabase?: SupabaseServerClient;
}): Promise<string> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase
    .from("workspaces")
    .select("timezone")
    .eq("id", workspaceId)
    .single<{ timezone: string }>();

  if (error) {
    throw new Error(`Unable to load workspace timezone: ${error.message}`);
  }

  return data.timezone;
}

export async function setWorkspaceTimezone({
  workspaceId,
  timezone,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  timezone: string;
  supabase?: SupabaseServerClient;
}): Promise<void> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("set_workspace_timezone_authorized", {
    p_workspace_id: workspaceId,
    p_timezone: timezone,
  });

  if (error) {
    throw new Error(`Unable to update workspace timezone: ${error.message}`);
  }
}

export async function setRecurrenceRuleActive({
  workspaceId,
  recurrenceRuleId,
  active,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  recurrenceRuleId: string;
  active: boolean;
  supabase?: SupabaseServerClient;
}): Promise<void> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("set_process_recurrence_rule_active_authorized", {
    p_workspace_id: workspaceId,
    p_recurrence_rule_id: recurrenceRuleId,
    p_active: active,
  });

  if (error) {
    throw new Error(`Unable to update recurrence rule: ${error.message}`);
  }
}
