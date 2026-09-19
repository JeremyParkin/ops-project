// DB/RPC-level verification for Phase 13.3 (migration 0137): Choice-option
// safe permanent deletion, archive-first, plus the entity_views hardening
// (locked/validated create+update RPCs) that closes the concurrency window
// a raw, unlocked saved-view write otherwise left open against it.
//
// NOTE: this suite requires migration 0137 to be applied before it can run
// against the live database -- written ahead of application per the
// explicit "implement now, verify later" instruction for this slice.
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];

afterAll(async () => {
  const admin = createSupabaseTestClient();
  if (createdWorkspaceIds.length > 0) {
    const { error } = await admin.from("workspaces").delete().in("id", createdWorkspaceIds);
    if (error) throw new Error(error.message);
  }
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
}, 30_000);

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `ChoiceDelete-${randomUUID()}!`;
  const email = `e2e-choice-delete-${label}-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user.");
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function authenticatedClient(user: User): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return client;
}

async function createWorkspace(name: string) {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error } = await admin.from("workspaces").insert({ id: workspaceId, name: `${name} ${workspaceId.slice(0, 8)}` });
  if (error) throw new Error(error.message);
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length > 0) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }
  return id;
}

async function memberWithCapabilities(workspaceId: string, label: string, capabilities: string[]) {
  const user = await createUser(label);
  const roleId = await createRole(workspaceId, `${label}-${randomUUID().slice(0, 6)}`, capabilities);
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: user.id, role_id: roleId });
  if (error) throw new Error(error.message);
  return user;
}

async function createEntityType(workspaceId: string, name: string) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error } = await admin.from("entity_types").insert({
    id,
    workspace_id: workspaceId,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(0, 8)}`,
  });
  if (error) throw new Error(error.message);
  return id;
}

async function createField(
  workspaceId: string,
  entityTypeId: string,
  opts: { key: string; name: string; type: string; position: number; relatedEntityTypeId?: string },
) {
  const admin = createSupabaseTestClient();
  const fieldId = randomUUID();
  const uniqueKey = `${opts.key}_${fieldId.slice(0, 8)}`;
  const { error } = await admin.from("field_definitions").insert({
    id: fieldId,
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    key: uniqueKey,
    name: opts.name,
    slug: opts.key,
    type: opts.type,
    required: false,
    position: opts.position,
    related_entity_type_id: opts.relatedEntityTypeId ?? null,
  });
  if (error) throw new Error(error.message);
  return { id: fieldId, key: uniqueKey };
}

async function addOption(client: SupabaseClient, workspaceId: string, fieldId: string, label: string) {
  const { data, error } = await client.rpc("add_field_choice_option", {
    p_workspace_id: workspaceId,
    p_field_definition_id: fieldId,
    p_label: label,
    p_color: "gray",
  });
  if (error) throw new Error(error.message);
  return data as string;
}

async function archiveOption(client: SupabaseClient, workspaceId: string, fieldId: string, optionId: string) {
  const { error } = await client.rpc("archive_field_choice_option", {
    p_workspace_id: workspaceId,
    p_field_definition_id: fieldId,
    p_option_id: optionId,
  });
  if (error) throw new Error(error.message);
}

async function optionExists(workspaceId: string, optionId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("field_choice_options")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", optionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

type DeleteResult = {
  deleted: boolean;
  record_value_count: number;
  view_reference_count: number;
  quality_review_reference_count: number;
};

async function attemptDelete(client: SupabaseClient, workspaceId: string, fieldId: string, optionId: string) {
  const result = await client.rpc("delete_field_choice_option_if_safe_authorized", {
    p_workspace_id: workspaceId,
    p_field_definition_id: fieldId,
    p_option_id: optionId,
  });
  return result as unknown as { data: DeleteResult[] | null; error: { message: string } | null };
}

describe("Choice option safe deletion (archive-first, dependency-checked)", () => {
  // Concurrency is verified three ways in this file, deliberately NOT
  // including black-box HTTP wall-clock timing. A timing-based proof (fire
  // batches of concurrent RPC calls sharing vs. not sharing the advisory
  // lock key, and assert the shared-key batch takes measurably longer) was
  // built and run repeatedly against development. It was discarded: across
  // five repeated runs the "same entity type" (must-serialize) batch was
  // sometimes FASTER than the "different entity types" (must-not-serialize)
  // batch. Each RPC's real in-transaction work is a few milliseconds; the
  // PostgREST/Supavisor/network round-trip per call is tens of milliseconds
  // and varies by more than the lock's own contribution, so wall-clock
  // timing over HTTP cannot isolate the lock's effect from that noise in
  // this environment (no direct pg_locks/pg_stat_activity introspection is
  // available here either -- no psql, no information_schema/pg_catalog over
  // PostgREST). Tuning thresholds until a timing test passes would prove
  // nothing real, so instead:
  //   1. "takes the identical lock, before any dependency read or write"
  //      below inspects the actual deployed SQL text structurally.
  //   2. "closes the delete-vs-view-write race" (further down) fires a
  //      genuine concurrent pair of real transactions and asserts the
  //      invariant holds under BOTH possible commit orderings.
  //   3. The raw-DELETE/raw-INSERT-UPDATE refusal tests (further down)
  //      confirm no caller can reach entity_views or field_choice_options
  //      outside the locked RPC paths at all, so those two orderings are
  //      exhaustive -- there is no third, lock-bypassing path to race.
  it("takes the identical entity-type advisory lock, before any dependency read or write, in delete_field_choice_option_if_safe and both entity-view write RPCs", () => {
    const migrationPath = path.join(
      import.meta.dirname,
      "../../supabase/migrations/0137_choice_option_safe_delete.sql",
    );
    const migrationSql = readFileSync(migrationPath, "utf8");

    function functionBody(name: string) {
      const start = migrationSql.indexOf(`create function ${name}(`);
      expect(start, `function ${name} not found in 0137`).toBeGreaterThan(-1);
      const end = migrationSql.indexOf("\n$$;", start);
      expect(end, `end of function ${name} not found in 0137`).toBeGreaterThan(start);
      return migrationSql.slice(start, end);
    }

    const lockCall = "pg_advisory_xact_lock(hashtextextended(";

    for (const name of [
      "delete_field_choice_option_if_safe",
      "create_entity_view_authorized",
      "update_entity_view_authorized",
    ]) {
      const body = functionBody(name);
      const lockIndex = body.indexOf(lockCall);
      expect(lockIndex, `${name} must call pg_advisory_xact_lock`).toBeGreaterThan(-1);

      // Same lock key shape as record create/update (migration 0080) and
      // every other entity-type-scoped writer in this codebase: hashed on
      // entity_type_id specifically (optionally variable-qualified, e.g.
      // v_field.entity_type_id), not some other id.
      expect(body.slice(lockIndex, lockIndex + lockCall.length + 40)).toMatch(/entity_type_id::text, 0\)\)/);

      // Nothing that reads a dependency count, locks a row, or writes
      // happens before the lock is acquired -- an existence check on the
      // caller-supplied id is fine (both functions do this), but no
      // "for update" row lock, INSERT, UPDATE, or DELETE.
      const beforeLock = body.slice(0, lockIndex);
      expect(beforeLock, `${name} must not lock rows or write before taking the advisory lock`).not.toMatch(
        /for update|insert into|delete from|update\s+\w+\s+set/i,
      );
    }
  });

  it("refuses to delete an active (never-archived) option, via direct authorized-RPC invocation, and leaves the row intact", async () => {
    const workspaceId = await createWorkspace("Choice Delete Active");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
    const builderClient = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const { id: fieldId } = await createField(workspaceId, entityTypeId, { key: "priority", name: "Priority", type: "choice", position: 1 });
    const optionId = await addOption(builderClient, workspaceId, fieldId, "High");

    // Never archived -- direct RPC invocation, bypassing any app-layer
    // pre-check entirely.
    const { data, error } = await attemptDelete(builderClient, workspaceId, fieldId, optionId);
    expect(data).toBeNull();
    expect(error?.message).toMatch(/must be archived/i);

    expect(await optionExists(workspaceId, optionId)).toBe(true);
  });

  it("deletes a genuinely unreferenced archived option and writes a governance event", async () => {
    const workspaceId = await createWorkspace("Choice Delete Unreferenced");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
    const builderClient = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const { id: fieldId } = await createField(workspaceId, entityTypeId, { key: "priority", name: "Priority", type: "choice", position: 1 });
    const optionId = await addOption(builderClient, workspaceId, fieldId, "Mistaken Option");
    await archiveOption(builderClient, workspaceId, fieldId, optionId);

    const { data, error } = await attemptDelete(builderClient, workspaceId, fieldId, optionId);
    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({
      deleted: true,
      record_value_count: 0,
      view_reference_count: 0,
      quality_review_reference_count: 0,
    });

    expect(await optionExists(workspaceId, optionId)).toBe(false);

    // subject_id is a soft reference reused across this option's whole
    // lifecycle (created -> archived -> deleted), so it alone does not
    // identify the delete event -- filter by event_type too.
    const admin = createSupabaseTestClient();
    const { data: events, error: eventsError } = await admin
      .from("governance_audit_events")
      .select("event_type, subject_id, subject_name_snapshot")
      .eq("workspace_id", workspaceId)
      .eq("subject_id", optionId)
      .eq("event_type", "choice_option_deleted");
    expect(eventsError).toBeNull();
    expect(events).toEqual([
      expect.objectContaining({ event_type: "choice_option_deleted", subject_id: optionId, subject_name_snapshot: "Mistaken Option" }),
    ]);
  });

  it("blocks deletion when referenced by an ACTIVE record's value, and by an ARCHIVED record's value", async () => {
    const workspaceId = await createWorkspace("Choice Delete Record Refs");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
    const builderClient = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const { id: fieldId, key: fieldKey } = await createField(workspaceId, entityTypeId, { key: "priority", name: "Priority", type: "choice", position: 1 });

    const activeRefOptionId = await addOption(builderClient, workspaceId, fieldId, "Used By Active Record");
    const { data: activeRecordId, error: createActiveError } = await builderClient.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_values: { [fieldKey]: activeRefOptionId }, p_relations: [],
    });
    expect(createActiveError).toBeNull();
    await archiveOption(builderClient, workspaceId, fieldId, activeRefOptionId);

    const activeAttempt = await attemptDelete(builderClient, workspaceId, fieldId, activeRefOptionId);
    expect(activeAttempt.error).toBeNull();
    expect(activeAttempt.data?.[0]).toMatchObject({ deleted: false, record_value_count: 1 });
    expect(await optionExists(workspaceId, activeRefOptionId)).toBe(true);

    // Archiving the record must never rewrite its stored values -- the
    // option is still referenced, and deletion must still be blocked.
    const { error: archiveRecordError } = await builderClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_record_ids: [activeRecordId], p_archived: true,
    });
    expect(archiveRecordError).toBeNull();

    const afterRecordArchivedAttempt = await attemptDelete(builderClient, workspaceId, fieldId, activeRefOptionId);
    expect(afterRecordArchivedAttempt.error).toBeNull();
    expect(afterRecordArchivedAttempt.data?.[0]).toMatchObject({ deleted: false, record_value_count: 1 });
    expect(await optionExists(workspaceId, activeRefOptionId)).toBe(true);
  });

  it("blocks deletion when referenced by a saved view's Choice filter value", async () => {
    const workspaceId = await createWorkspace("Choice Delete View Refs");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
    const builderClient = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const { id: fieldId } = await createField(workspaceId, entityTypeId, { key: "priority", name: "Priority", type: "choice", position: 1 });
    const optionId = await addOption(builderClient, workspaceId, fieldId, "Filtered Option");

    const { data: view, error: createViewError } = await builderClient
      .rpc("create_entity_view_authorized", {
        p_workspace_id: workspaceId,
        p_entity_type_id: entityTypeId,
        p_name: "High priority",
        p_filters: [{ fieldDefinitionId: fieldId, operator: "equals", value: optionId }],
        p_sorts: [],
        p_column_field_definition_ids: [],
      })
      .single();
    expect(createViewError).toBeNull();
    expect(view).toBeTruthy();

    await archiveOption(builderClient, workspaceId, fieldId, optionId);

    const { data, error } = await attemptDelete(builderClient, workspaceId, fieldId, optionId);
    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({ deleted: false, view_reference_count: 1 });
    expect(await optionExists(workspaceId, optionId)).toBe(true);
  });

  it("blocks deletion when the option is the Quality Review draft or finalized designation", async () => {
    const workspaceId = await createWorkspace("Choice Delete QR Refs");
    const builder = await memberWithCapabilities(workspaceId, "builder", [
      "schema.manage", "records.operate", "people_data.view_all",
    ]);
    const builderClient = await authenticatedClient(builder);

    const personEntityTypeId = await createEntityType(workspaceId, "Person");
    const designate = await builderClient.rpc("set_person_entity_type_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: personEntityTypeId,
    });
    expect(designate.error).toBeNull();

    const reviewEntityTypeId = await createEntityType(workspaceId, "Quality Review");
    const { id: subjectFieldId } = await createField(workspaceId, reviewEntityTypeId, {
      key: "subject", name: "Subject", type: "relation", position: 1, relatedEntityTypeId: personEntityTypeId,
    });
    const { id: reviewerFieldId } = await createField(workspaceId, reviewEntityTypeId, {
      key: "reviewer", name: "Reviewer", type: "relation", position: 2, relatedEntityTypeId: personEntityTypeId,
    });
    const { id: statusFieldId } = await createField(workspaceId, reviewEntityTypeId, {
      key: "status", name: "Status", type: "choice", position: 3,
    });
    const draftOptionId = await addOption(builderClient, workspaceId, statusFieldId, "Draft");
    const finalizedOptionId = await addOption(builderClient, workspaceId, statusFieldId, "Finalized");
    // A third option, never the live designation -- freely archivable,
    // since field_choice_options_reject_qr_archive (0105) only blocks
    // archiving whichever option is *currently* the Draft/Finalized
    // designation, not options in general on a Quality Review's status
    // field.
    const staleOptionId = await addOption(builderClient, workspaceId, statusFieldId, "Stale Draft");

    const enableSensitive = await builderClient.rpc("set_entity_type_people_sensitive_access_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: reviewEntityTypeId, p_people_sensitive: true,
      p_subject_person_field_id: subjectFieldId, p_author_person_field_id: reviewerFieldId,
      p_subject_can_view: true, p_manager_can_view: true, p_author_can_view: true,
    });
    expect(enableSensitive.error).toBeNull();

    const enableLifecycle = await builderClient.rpc("set_entity_type_quality_review_lifecycle_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: reviewEntityTypeId, p_quality_review: true,
      p_status_field_id: statusFieldId, p_draft_option_id: draftOptionId, p_finalized_option_id: finalizedOptionId,
    });
    expect(enableLifecycle.error).toBeNull();

    // The live designation genuinely cannot be archived while Quality
    // Review is active -- confirm that pre-existing trigger-level guard is
    // still in force (it is the primary defense; the delete RPC's own
    // check is a deliberate second, independent layer, not the only one).
    // It fires even for a direct service-role UPDATE, not just the RPC.
    const admin = createSupabaseTestClient();
    const blockedArchive = await admin
      .from("field_choice_options")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", draftOptionId);
    expect(blockedArchive.error?.message).toMatch(/cannot be archived while Quality Review is active/i);

    // Construct the specific state the delete RPC's own check exists to
    // catch as a backstop: archive an option freely (it's not the live
    // designation, so the trigger above doesn't apply to it), then point
    // the entity type's designation at it directly -- bypassing
    // set_entity_type_quality_review_lifecycle_authorized's own validation
    // (which requires an active option), the same way the real composite
    // FK alone would also permit this, since an FK only requires the row
    // to exist, not to be active.
    await archiveOption(builderClient, workspaceId, statusFieldId, staleOptionId);
    const { error: pointAtStaleError } = await admin
      .from("entity_types")
      .update({ quality_review_draft_option_id: staleOptionId })
      .eq("id", reviewEntityTypeId);
    expect(pointAtStaleError).toBeNull();

    const staleAttempt = await attemptDelete(builderClient, workspaceId, statusFieldId, staleOptionId);
    expect(staleAttempt.error).toBeNull();
    expect(staleAttempt.data?.[0]).toMatchObject({ deleted: false, quality_review_reference_count: 1 });
    expect(await optionExists(workspaceId, staleOptionId)).toBe(true);
  });

  it("enforces the schema.manage boundary: a records.operate-only caller cannot delete", async () => {
    const workspaceId = await createWorkspace("Choice Delete Capability Boundary");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
    const builderClient = await authenticatedClient(builder);
    const worker = await memberWithCapabilities(workspaceId, "worker", ["records.operate"]);
    const workerClient = await authenticatedClient(worker);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const { id: fieldId } = await createField(workspaceId, entityTypeId, { key: "priority", name: "Priority", type: "choice", position: 1 });
    const optionId = await addOption(builderClient, workspaceId, fieldId, "Blocked");
    await archiveOption(builderClient, workspaceId, fieldId, optionId);

    const { data, error } = await attemptDelete(workerClient, workspaceId, fieldId, optionId);
    expect(data).toBeNull();
    expect(error?.message).toMatch(/permission denied|schema\.manage/i);
    expect(await optionExists(workspaceId, optionId)).toBe(true);
  });

  it("enforces the workspace boundary: a caller cannot delete an option belonging to a different workspace", async () => {
    const workspaceAId = await createWorkspace("Choice Delete Cross A");
    const workspaceBId = await createWorkspace("Choice Delete Cross B");
    const builderA = await memberWithCapabilities(workspaceAId, "builder-a", ["schema.manage", "records.operate"]);
    const builderAClient = await authenticatedClient(builderA);
    const builderB = await memberWithCapabilities(workspaceBId, "builder-b", ["schema.manage", "records.operate"]);
    const builderBClient = await authenticatedClient(builderB);

    const entityTypeId = await createEntityType(workspaceBId, "Task");
    const { id: fieldId } = await createField(workspaceBId, entityTypeId, { key: "priority", name: "Priority", type: "choice", position: 1 });
    const optionId = await addOption(builderBClient, workspaceBId, fieldId, "Belongs To B");
    await archiveOption(builderBClient, workspaceBId, fieldId, optionId);

    // Builder A (a genuine schema.manage member of workspace A, no
    // membership in B at all) attempts to delete B's option by passing B's
    // ids alongside A's own workspace id, and separately by passing B's
    // workspace id directly while only ever having signed in as A.
    const { data, error } = await attemptDelete(builderAClient, workspaceAId, fieldId, optionId);
    expect(data).toBeNull();
    expect(error).not.toBeNull();

    const crossWorkspaceId = await attemptDelete(builderAClient, workspaceBId, fieldId, optionId);
    expect(crossWorkspaceId.data).toBeNull();
    expect(crossWorkspaceId.error).not.toBeNull();

    expect(await optionExists(workspaceBId, optionId)).toBe(true);
  });

  it("refuses a raw DELETE against field_choice_options for a schema.manage caller", async () => {
    const workspaceId = await createWorkspace("Choice Delete Raw Refused");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
    const builderClient = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const { id: fieldId } = await createField(workspaceId, entityTypeId, { key: "priority", name: "Priority", type: "choice", position: 1 });
    const optionId = await addOption(builderClient, workspaceId, fieldId, "Raw Delete Target");
    await archiveOption(builderClient, workspaceId, fieldId, optionId);

    const { error, count } = await builderClient
      .from("field_choice_options")
      .delete({ count: "exact" })
      .eq("workspace_id", workspaceId)
      .eq("id", optionId);

    expect(error).not.toBeNull();
    expect(count ?? 0).toBe(0);
    expect(await optionExists(workspaceId, optionId)).toBe(true);
  });

  it("refuses a raw INSERT/UPDATE against entity_views for a records.operate caller", async () => {
    const workspaceId = await createWorkspace("Choice Delete Views Raw Refused");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
    const builderClient = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");

    const { error: insertError } = await builderClient.from("entity_views").insert({
      workspace_id: workspaceId, entity_type_id: entityTypeId, name: "Raw Insert Attempt",
      position: 1, filters: [], sorts: [], column_field_definition_ids: [],
    });
    expect(insertError).not.toBeNull();

    const { data: view } = await builderClient
      .rpc("create_entity_view_authorized", {
        p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_name: "Legit View",
        p_filters: [], p_sorts: [], p_column_field_definition_ids: [],
      })
      .single<{ id: string }>();
    expect(view).toBeTruthy();

    const { error: updateError } = await builderClient
      .from("entity_views")
      .update({ name: "Raw Update Attempt" })
      .eq("workspace_id", workspaceId)
      .eq("id", view!.id);
    expect(updateError).not.toBeNull();

    const admin = createSupabaseTestClient();
    const { data: unchanged } = await admin.from("entity_views").select("name").eq("id", view!.id).single();
    expect(unchanged?.name).toBe("Legit View");
  });

  it("still supports create/update/default-view workflows through the new authorized RPCs", async () => {
    const workspaceId = await createWorkspace("Choice Delete Views Still Work");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
    const builderClient = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const { id: fieldId } = await createField(workspaceId, entityTypeId, { key: "priority", name: "Priority", type: "choice", position: 1 });
    const optionId = await addOption(builderClient, workspaceId, fieldId, "Still Active");

    const { data: created, error: createError } = await builderClient
      .rpc("create_entity_view_authorized", {
        p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_name: "First view",
        p_filters: [{ fieldDefinitionId: fieldId, operator: "equals", value: optionId }],
        p_sorts: [], p_column_field_definition_ids: [fieldId],
      })
      .single<{ id: string; position: number }>();
    expect(createError).toBeNull();
    expect(created?.position).toBe(1);

    const { data: second, error: secondError } = await builderClient
      .rpc("create_entity_view_authorized", {
        p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_name: "Second view",
        p_filters: [], p_sorts: [], p_column_field_definition_ids: [],
      })
      .single<{ id: string; position: number }>();
    expect(secondError).toBeNull();
    expect(second?.position).toBe(2);

    const { data: updated, error: updateError } = await builderClient
      .rpc("update_entity_view_authorized", {
        p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_view_id: created!.id,
        p_name: "First view renamed", p_filters: [], p_sorts: [], p_column_field_definition_ids: [],
      })
      .single<{ name: string }>();
    expect(updateError).toBeNull();
    expect(updated?.name).toBe("First view renamed");

    const { error: defaultError } = await builderClient.rpc("set_entity_default_view", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_view_id: second!.id,
    });
    expect(defaultError).toBeNull();

    const admin = createSupabaseTestClient();
    const { data: views } = await admin.from("entity_views").select("id, is_default").eq("entity_type_id", entityTypeId);
    expect(views?.find((view) => view.id === second!.id)?.is_default).toBe(true);
    expect(views?.find((view) => view.id === created!.id)?.is_default).toBe(false);
  });

  it("rejects creating/updating a view whose Choice filter references a nonexistent option", async () => {
    const workspaceId = await createWorkspace("Choice Delete View Validation");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
    const builderClient = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const { id: fieldId } = await createField(workspaceId, entityTypeId, { key: "priority", name: "Priority", type: "choice", position: 1 });

    const { error } = await builderClient.rpc("create_entity_view_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_name: "Dangling",
      p_filters: [{ fieldDefinitionId: fieldId, operator: "equals", value: randomUUID() }],
      p_sorts: [], p_column_field_definition_ids: [],
    });
    expect(error?.message).toMatch(/no longer exists/i);
  });

  it("closes the delete-vs-view-write race: a concurrent create/update targeting a just-deleted option never persists a dangling reference", async () => {
    const workspaceId = await createWorkspace("Choice Delete Concurrency");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
    const builderClient = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const { id: fieldId } = await createField(workspaceId, entityTypeId, { key: "priority", name: "Priority", type: "choice", position: 1 });
    const optionId = await addOption(builderClient, workspaceId, fieldId, "Race Target");
    await archiveOption(builderClient, workspaceId, fieldId, optionId);

    // Both paths take the identical pg_advisory_xact_lock keyed by
    // entity_type_id (migration 0137), so this is a genuine race between
    // two real transactions, not a simulated ordering -- whichever
    // acquires the lock first fully commits before the other proceeds.
    const [deleteResult, viewResult] = await Promise.all([
      attemptDelete(builderClient, workspaceId, fieldId, optionId),
      builderClient
        .rpc("create_entity_view_authorized", {
          p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_name: "Racing view",
          p_filters: [{ fieldDefinitionId: fieldId, operator: "equals", value: optionId }],
          p_sorts: [], p_column_field_definition_ids: [],
        })
        .single<{ id: string }>(),
    ]);

    const optionStillExists = await optionExists(workspaceId, optionId);

    if (viewResult.error) {
      // The delete won the lock first: the option was gone by the time the
      // view write validated its filter, so the write is correctly refused.
      expect(viewResult.error.message).toMatch(/no longer exists/i);
      expect(deleteResult.data?.[0]?.deleted).toBe(true);
      expect(optionStillExists).toBe(false);
    } else {
      // The view write won the lock first: the delete's own dependency
      // count, taken after the view write committed, must see the new
      // reference and refuse to delete.
      expect(deleteResult.data?.[0]).toMatchObject({ deleted: false, view_reference_count: 1 });
      expect(optionStillExists).toBe(true);
    }

    // Either way, there is never a saved view referencing a deleted option.
    const admin = createSupabaseTestClient();
    const { data: danglingViews } = await admin
      .from("entity_views")
      .select("id, filters")
      .eq("workspace_id", workspaceId)
      .eq("entity_type_id", entityTypeId);
    for (const view of danglingViews ?? []) {
      const filters = view.filters as Array<{ fieldDefinitionId: string; value?: string }>;
      const referencesDeletedOption = filters.some((filter) => filter.value === optionId);
      if (referencesDeletedOption) {
        expect(optionStillExists).toBe(true);
      }
    }
  });
});
