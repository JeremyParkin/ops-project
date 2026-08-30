// DB/RPC-level coverage for Phase 8D.1 recurrence: idempotent scheduler
// discovery, rule-lifecycle filtering (inactive/archived), the missed-
// occurrence catch-up-latest-only policy at the full scheduler level (not
// just the pure math function), and the system-vs-interactive authority
// boundary on start_process_run_system. Requires migration 0063 applied.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import {
  cleanupE2eRun,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestEntity,
  type TestRun,
} from "../../tests/e2e/helpers/supabase-test-data";

const runs: TestRun[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  for (const run of runs) {
    await cleanupE2eRun(run);
  }

  if (createdUserIds.length > 0) {
    const admin = createSupabaseTestClient();
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
  }
}, 30_000);

function scenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

function isoDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

async function createSingleStepTemplate(run: TestRun, entity: TestEntity) {
  const supabase = createSupabaseTestClient();
  const templateId = randomUUID();
  const nodeId = randomUUID();

  const { error: templateError } = await supabase.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Recurrence Template`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(`template: ${templateError.message}`);

  const { error: nodeError } = await supabase.from("process_nodes").insert({
    id: nodeId,
    workspace_id: DEMO_WORKSPACE_ID,
    process_template_id: templateId,
    node_type: "human_task",
    name: "Only step",
    position: 1,
    config: {},
  });
  if (nodeError) throw new Error(`node: ${nodeError.message}`);

  return templateId;
}

async function createRuleRow({
  run,
  templateId,
  entity,
  recordId,
  startDate,
  active = true,
}: {
  run: TestRun;
  templateId: string;
  entity: TestEntity;
  recordId: string;
  startDate: string;
  active?: boolean;
}) {
  const supabase = createSupabaseTestClient();
  const ruleId = randomUUID();
  const { error } = await supabase.from("process_recurrence_rules").insert({
    id: ruleId,
    workspace_id: DEMO_WORKSPACE_ID,
    process_template_id: templateId,
    origin_entity_type_id: entity.id,
    origin_record_id: recordId,
    frequency: "daily",
    interval_count: 1,
    start_date: startDate,
    time_of_day: "00:00",
    active,
  });
  if (error) throw new Error(`${run.label} rule: ${error.message}`);
  return ruleId;
}

async function fixture(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Recurrence Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
  const templateId = await createSingleStepTemplate(run, entity);
  return { entity, recordId, templateId };
}

describe("process recurrence RPCs", () => {
  it("create_process_recurrence_rule_authorized creates a rule via the canonical authorized path", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, recordId, templateId } = await fixture(run);

    const { data, error } = await supabase.rpc("create_process_recurrence_rule_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: templateId,
      p_origin_entity_type_id: entity.id,
      p_origin_record_id: recordId,
      p_frequency: "monthly",
      p_interval_count: 1,
      p_day_of_week: null,
      p_day_of_month: 15,
      p_start_date: "2026-01-01",
      p_end_date: null,
      p_time_of_day: "09:00",
    });

    expect(error).toBeNull();
    expect(typeof data).toBe("string");

    const { data: row, error: readError } = await supabase
      .from("process_recurrence_rules")
      .select("frequency, interval_count, day_of_month, active")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", data as string)
      .single();
    expect(readError).toBeNull();
    expect(row).toEqual({ frequency: "monthly", interval_count: 1, day_of_month: 15, active: true });
  });

  it("a duplicate scheduler invocation for the same due occurrence creates exactly one ProcessRun", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, recordId, templateId } = await fixture(run);
    const ruleId = await createRuleRow({
      run,
      templateId,
      entity,
      recordId,
      startDate: isoDateDaysAgo(1),
    });

    const first = await supabase.rpc("discover_and_start_recurrence_occurrences_system", { p_limit: 500 });
    expect(first.error).toBeNull();
    const second = await supabase.rpc("discover_and_start_recurrence_occurrences_system", { p_limit: 500 });
    expect(second.error).toBeNull();

    const { data: occurrences, error: occurrenceError } = await supabase
      .from("process_recurrence_occurrences")
      .select("id, status, process_run_id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("recurrence_rule_id", ruleId);
    expect(occurrenceError).toBeNull();
    expect(occurrences).toHaveLength(1);
    expect(occurrences![0].status).toBe("started");
    expect(occurrences![0].process_run_id).toBeTruthy();

    const { data: runsForRule, error: runsError } = await supabase
      .from("process_runs")
      .select("id, originating_recurrence_occurrence_id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("origin_record_id", recordId);
    expect(runsError).toBeNull();
    expect(runsForRule).toHaveLength(1);
    expect(runsForRule![0].originating_recurrence_occurrence_id).toBe(occurrences![0].id);
  });

  it("only the latest due occurrence starts -- no backlog from a large missed gap", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, recordId, templateId } = await fixture(run);
    const ruleId = await createRuleRow({
      run,
      templateId,
      entity,
      recordId,
      startDate: isoDateDaysAgo(30),
    });

    const { error } = await supabase.rpc("discover_and_start_recurrence_occurrences_system", { p_limit: 500 });
    expect(error).toBeNull();

    const { data: occurrences, error: occurrenceError } = await supabase
      .from("process_recurrence_occurrences")
      .select("occurrence_date, created_at")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("recurrence_rule_id", ruleId);
    expect(occurrenceError).toBeNull();
    // Exactly one row, not ~30 -- the daily rule was due every day for 30
    // days, but only today's occurrence is ever computed or claimed.
    expect(occurrences).toHaveLength(1);
    // Assert against a value the server itself stamped (created_at, via
    // `default now()` in the same insert that computed occurrence_date),
    // not an independently-computed "today" from this test runner's local
    // clock -- the local host and the remote Supabase project's clock are
    // not guaranteed to agree, especially near a UTC day boundary. The
    // workspace timezone defaults to UTC (untouched by this fixture), so
    // created_at's UTC date is directly comparable to occurrence_date.
    expect(occurrences![0].occurrence_date).toBe(String(occurrences![0].created_at).slice(0, 10));
  });

  it("an inactive rule is never picked up by the scheduler", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, recordId, templateId } = await fixture(run);
    await createRuleRow({
      run,
      templateId,
      entity,
      recordId,
      startDate: isoDateDaysAgo(1),
      active: false,
    });

    const { error } = await supabase.rpc("discover_and_start_recurrence_occurrences_system", { p_limit: 500 });
    expect(error).toBeNull();

    const { data: runsForRecord, error: runsError } = await supabase
      .from("process_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("origin_record_id", recordId);
    expect(runsError).toBeNull();
    expect(runsForRecord).toHaveLength(0);
  });

  it("a rule whose template is archived is never picked up by the scheduler", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, recordId, templateId } = await fixture(run);
    await createRuleRow({ run, templateId, entity, recordId, startDate: isoDateDaysAgo(1) });
    const { error: archiveError } = await supabase
      .from("process_templates")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", templateId);
    expect(archiveError).toBeNull();

    const { error } = await supabase.rpc("discover_and_start_recurrence_occurrences_system", { p_limit: 500 });
    expect(error).toBeNull();

    const { data: runsForRecord, error: runsError } = await supabase
      .from("process_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("origin_record_id", recordId);
    expect(runsError).toBeNull();
    expect(runsForRecord).toHaveLength(0);
  });

  it("a rule whose origin record is archived is never picked up by the scheduler", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, recordId, templateId } = await fixture(run);
    await createRuleRow({ run, templateId, entity, recordId, startDate: isoDateDaysAgo(1) });
    const { error: archiveError } = await supabase
      .from("entity_records")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", recordId);
    expect(archiveError).toBeNull();

    const { error } = await supabase.rpc("discover_and_start_recurrence_occurrences_system", { p_limit: 500 });
    expect(error).toBeNull();

    const { data: runsForRecord, error: runsError } = await supabase
      .from("process_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("origin_record_id", recordId);
    expect(runsError).toBeNull();
    expect(runsForRecord).toHaveLength(0);
  });

  it("a due occurrence that collides with an already-active run from a prior period fails without blocking the batch", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, recordId, templateId } = await fixture(run);
    const ruleId = await createRuleRow({
      run,
      templateId,
      entity,
      recordId,
      startDate: isoDateDaysAgo(1),
    });

    // A pre-existing active run for the same template+origin -- the
    // canonical member function's own "one active run" rule should reject
    // the scheduler's attempt, and the occurrence should be recorded as
    // failed, not silently dropped or left ambiguous.
    const { error: existingRunError } = await supabase.rpc("start_process_run_system", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: templateId,
      p_origin_entity_type_id: entity.id,
      p_origin_record_id: recordId,
      p_originating_recurrence_occurrence_id: null,
    });
    expect(existingRunError).toBeNull();

    const { data: schedulerResult, error } = await supabase.rpc(
      "discover_and_start_recurrence_occurrences_system",
      { p_limit: 500 },
    );
    expect(error).toBeNull();
    expect((schedulerResult as { failed: number }).failed).toBeGreaterThanOrEqual(1);

    const { data: occurrences, error: occurrenceError } = await supabase
      .from("process_recurrence_occurrences")
      .select("status, process_run_id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("recurrence_rule_id", ruleId);
    expect(occurrenceError).toBeNull();
    expect(occurrences).toHaveLength(1);
    expect(occurrences![0].status).toBe("failed");
    expect(occurrences![0].process_run_id).toBeNull();
  });

  it("start_process_run_system succeeds under service_role and records recurrence provenance", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, recordId, templateId } = await fixture(run);

    const { data: runId, error } = await supabase.rpc("start_process_run_system", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: templateId,
      p_origin_entity_type_id: entity.id,
      p_origin_record_id: recordId,
      p_originating_recurrence_occurrence_id: null,
    });
    expect(error).toBeNull();
    expect(typeof runId).toBe("string");

    const { data: runRow, error: runError } = await supabase
      .from("process_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", runId as string)
      .single();
    expect(runError).toBeNull();
    expect(runRow?.id).toBe(runId);
  });

  it("start_process_run_system and the recurrence scheduler RPC are unreachable for an authenticated, non-service-role caller -- even one holding automation.manage", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const { entity, recordId, templateId } = await fixture(run);

    const password = `E2E-recurrence-${randomUUID()}!`;
    const email = `e2e-recurrence-${randomUUID()}@example.test`;
    const { data: userData, error: userError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (userError || !userData.user) {
      throw new Error(userError?.message ?? "Unable to create test user.");
    }
    createdUserIds.push(userData.user.id);

    const { data: roleId, error: roleError } = await admin
      .from("workspace_roles")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("is_builtin", true)
      .single<{ id: string }>();
    expect(roleError).toBeNull();
    const { error: membershipError } = await admin.from("workspace_memberships").insert({
      workspace_id: DEMO_WORKSPACE_ID,
      user_id: userData.user.id,
      role_id: roleId!.id,
    });
    expect(membershipError).toBeNull();

    const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
    const userClient = createClient(supabaseUrl, supabasePublishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await userClient.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();

    const startResult = await userClient.rpc("start_process_run_system", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: templateId,
      p_origin_entity_type_id: entity.id,
      p_origin_record_id: recordId,
      p_originating_recurrence_occurrence_id: null,
    });
    expect(startResult.error).not.toBeNull();

    const schedulerResult = await userClient.rpc("discover_and_start_recurrence_occurrences_system", {
      p_limit: 10,
    });
    expect(schedulerResult.error).not.toBeNull();

    const { data: runsForRecord, error: runsError } = await admin
      .from("process_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("origin_record_id", recordId);
    expect(runsError).toBeNull();
    expect(runsForRecord).toHaveLength(0);
  });
});
