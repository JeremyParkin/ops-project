// DB/RPC-level coverage for Phase 8D.4 Search: search_workspace_records_
// authorized's ranking (display-label match, prefix vs. weaker substring
// match), searchable-field rules (text only, active only), the per-entity-
// type result cap, cross-workspace isolation, the object-type filter, and
// literal-LIKE-metacharacter handling. Requires migration 0066 applied.
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
  getE2eWorkspaceAdministratorRoleId,
  type TestEntity,
  type TestRun,
} from "../../tests/e2e/helpers/supabase-test-data";

const runs: TestRun[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  // Each scenario's run is independent (disjoint entities/records), so
  // cleaning them up concurrently rather than one at a time avoids the same
  // afterAll-hook-timeout pattern already fixed in process-runs.spec.ts and
  // activity-commit.test.ts.
  const failures: string[] = [];
  await Promise.all(
    runs.map((run) =>
      cleanupE2eRun(run).catch((error) => {
        failures.push(error instanceof Error ? error.message : String(error));
      }),
    ),
  );

  if (createdUserIds.length > 0) {
    const admin = createSupabaseTestClient();
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `search-commit afterAll cleanup: ${failures.length} step(s) failed after attempting all of them:\n${failures.join("\n")}`,
    );
  }
}, 30_000);

function scenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

type MatchRow = {
  entity_type_id: string;
  record_id: string;
  matched_field_id: string | null;
  matched_field_name: string | null;
  is_identity_match: boolean;
  is_prefix_match: boolean;
};

// search_workspace_records_authorized deliberately has no service_role
// bypass (unlike start_process_run_authorized_member's auth.role() =
// 'service_role' escape hatch) -- it's built only for an interactive
// session, matching list_record_activity_authorized's identical posture
// from 8D.3. Reads it with one shared authenticated member client, created
// once and reused across every test in this file, rather than the raw
// admin/service-role client every other helper here defaults to for
// convenience -- calling it as service_role fails the same "Workspace
// access denied" an outside caller gets, which is correct, not a bug.
let sharedMemberClientPromise: ReturnType<typeof createAuthenticatedMember> | undefined;

async function createAuthenticatedMember() {
  const admin = createSupabaseTestClient();
  const password = `E2E-search-${randomUUID()}!`;
  const email = `e2e-search-${randomUUID()}@example.test`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !userData.user) throw new Error(userError?.message ?? "Unable to create test member.");
  createdUserIds.push(userData.user.id);

  const roleId = await getE2eWorkspaceAdministratorRoleId(admin, DEMO_WORKSPACE_ID);
  const { error: membershipError } = await admin
    .from("workspace_memberships")
    .insert({ workspace_id: DEMO_WORKSPACE_ID, user_id: userData.user.id, role_id: roleId });
  if (membershipError) throw new Error(membershipError.message);

  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(signInError.message);
  return client;
}

function sharedMemberClient() {
  sharedMemberClientPromise ??= createAuthenticatedMember();
  return sharedMemberClientPromise;
}

async function search(
  query: string,
  options: { entityTypeId?: string; limitPerType?: number } = {},
) {
  const member = await sharedMemberClient();
  const { data, error } = await member.rpc("search_workspace_records_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_query: query,
    p_entity_type_id: options.entityTypeId ?? null,
    p_limit_per_type: options.limitPerType ?? 20,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as MatchRow[];
}

async function setDisplayField(entity: TestEntity, fieldId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.rpc("set_entity_display_field", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: entity.id,
    p_field_definition_id: fieldId,
  });
  if (error) throw new Error(error.message);
}

describe("search_workspace_records_authorized", () => {
  it("ranks a display-field match above a match in a non-identity field", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const entity = await createEntity(admin, run, "Search Rank Client", [
      { slug: "name", name: "Name", type: "text", required: true },
      { slug: "notes", name: "Notes", type: "text" },
    ]);
    await setDisplayField(entity, entity.fields.name.id);

    const displayMatchId = await createEntityRecord({
      entity,
      valuesBySlug: { name: `${run.label} Needle Displayed`, notes: "unrelated" },
    });
    const notesMatchId = await createEntityRecord({
      entity,
      valuesBySlug: { name: `${run.label} Other`, notes: `${run.label} needle in notes` },
    });

    const matches = await search(`${run.label} needle`);
    const forEntity = matches.filter((m) => m.entity_type_id === entity.id);
    expect(forEntity.map((m) => m.record_id)).toEqual([displayMatchId, notesMatchId]);
    // The RPC always returns the actual matched field's name -- suppressing
    // it for an identity-field match ("Matched in Name" would be noise
    // next to the record's own displayed label) is a presentation decision
    // made where the RPC's rows are mapped for display
    // (searchWorkspaceRecords), not something the RPC itself decides.
    expect(forEntity[0].is_identity_match).toBe(true);
    expect(forEntity[0].matched_field_name).toBe("Name");
    expect(forEntity[1].is_identity_match).toBe(false);
    expect(forEntity[1].matched_field_name).toBe("Notes");
  });

  it("ranks a prefix match above a weaker mid-string substring match on the same (non-identity) field", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const entity = await createEntity(admin, run, "Search Prefix Client", [
      { slug: "name", name: "Name", type: "text", required: true },
      { slug: "notes", name: "Notes", type: "text" },
    ]);
    await setDisplayField(entity, entity.fields.name.id);

    const midStringId = await createEntityRecord({
      entity,
      valuesBySlug: { name: `${run.label} A`, notes: "xNeedlex" },
    });
    const prefixId = await createEntityRecord({
      entity,
      valuesBySlug: { name: `${run.label} B`, notes: "Needlex" },
    });

    const matches = await search("needle");
    const forEntity = matches.filter((m) => m.entity_type_id === entity.id);
    const order = forEntity.map((m) => m.record_id);
    expect(order.indexOf(prefixId)).toBeLessThan(order.indexOf(midStringId));
  });

  it("only matches active text fields -- number/date/boolean/relation values are never searched", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const target = await createEntity(admin, run, "Search Type Target", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const targetRecordId = await createEntityRecord({ entity: target, valuesBySlug: { name: "Target" } });
    const entity = await createEntity(admin, run, "Search Field Types", [
      { slug: "name", name: "Name", type: "text", required: true },
      { slug: "amount", name: "Amount", type: "number" },
      { slug: "occurred", name: "Occurred", type: "date" },
      { slug: "active", name: "Active", type: "boolean" },
      {
        slug: "target",
        name: "Target",
        type: "relation",
        relatedEntityTypeId: target.id,
      },
    ]);
    await setDisplayField(entity, entity.fields.name.id);

    // A magic token planted only as a NUMBER value (as its string
    // representation happens to also be a valid unrelated marker) and as
    // the record's own id fragment/relation target -- neither should ever
    // surface as a match since neither is a text field.
    const marker = `${run.label.replace(/\s+/g, "")}42`;
    await createEntityRecord({
      entity,
      valuesBySlug: { name: `${run.label} Plain`, amount: 42 },
      relationsBySlug: { target: targetRecordId },
    });

    const byNumber = await search(marker);
    expect(byNumber.filter((m) => m.entity_type_id === entity.id)).toHaveLength(0);

    const byRelationTargetId = await search(targetRecordId);
    expect(byRelationTargetId.filter((m) => m.entity_type_id === entity.id)).toHaveLength(0);
  });

  it("excludes archived records, archived entity types, and archived fields", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const activeEntity = await createEntity(admin, run, "Search Archive Active", [
      { slug: "name", name: "Name", type: "text", required: true },
      { slug: "notes", name: "Notes", type: "text" },
    ]);
    const archivedEntity = await createEntity(admin, run, "Search Archive Type", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    await setDisplayField(activeEntity, activeEntity.fields.name.id);
    await setDisplayField(archivedEntity, archivedEntity.fields.name.id);

    const activeRecordId = await createEntityRecord({
      entity: activeEntity,
      valuesBySlug: { name: `${run.label} needle visible` },
    });
    const archivedRecordId = await createEntityRecord({
      entity: activeEntity,
      valuesBySlug: { name: `${run.label} needle archived record` },
    });
    await createEntityRecord({
      entity: archivedEntity,
      valuesBySlug: { name: `${run.label} needle archived entity` },
    });
    // A record whose only match would be through a field that gets
    // archived after the value was written -- proves the RPC re-resolves
    // searchable fields live on every call rather than caching which
    // fields were text/active at write time.
    const archivedFieldRecordId = await createEntityRecord({
      entity: activeEntity,
      valuesBySlug: { name: `${run.label} not a match`, notes: `${run.label} needle archived field` },
    });
    await admin
      .from("entity_records")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", archivedRecordId);
    await admin
      .from("entity_types")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", archivedEntity.id);

    // Confirm the "notes" field would have matched before it's archived.
    const beforeFieldArchive = await search(`${run.label} needle`);
    expect(beforeFieldArchive.map((m) => m.record_id)).toContain(archivedFieldRecordId);

    await admin
      .from("field_definitions")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", activeEntity.fields.notes.id);

    const matches = await search(`${run.label} needle`);
    expect(matches.map((m) => m.record_id)).toEqual([activeRecordId]);
  });

  it("enforces the per-entity-type cap in the database, not just display truncation", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const entity = await createEntity(admin, run, "Search Cap RPC", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    await setDisplayField(entity, entity.fields.name.id);

    for (let index = 1; index <= 25; index += 1) {
      await createEntityRecord({
        entity,
        valuesBySlug: { name: `${run.label} Capneedle ${String(index).padStart(2, "0")}` },
      });
    }

    const matches = await search(`${run.label} capneedle`, { limitPerType: 20 });
    expect(matches.filter((m) => m.entity_type_id === entity.id)).toHaveLength(20);
  });

  it("cross-workspace isolation: a real, authenticated demo-workspace member is rejected against a workspace they don't belong to", async () => {
    // Uses the shared authenticated member (a genuine demo-workspace
    // member) against a random, unrelated workspace id -- proving the
    // membership check itself discriminates by workspace, not merely that
    // any caller lacking a session is rejected (which the service-role
    // admin client would trivially satisfy regardless of workspace id,
    // proving nothing about cross-workspace isolation specifically).
    const member = await sharedMemberClient();
    const result = await member.rpc("search_workspace_records_authorized", {
      p_workspace_id: randomUUID(),
      p_query: "anything",
      p_entity_type_id: null,
      p_limit_per_type: 20,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("Workspace access denied");
  });

  it("similar labels across two different object types both appear, grouped by their own entity type", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const clientEntity = await createEntity(admin, run, "Search Similar Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const dealEntity = await createEntity(admin, run, "Search Similar Deal", [
      { slug: "title", name: "Title", type: "text", required: true },
    ]);
    await setDisplayField(clientEntity, clientEntity.fields.name.id);
    await setDisplayField(dealEntity, dealEntity.fields.title.id);

    const clientRecordId = await createEntityRecord({
      entity: clientEntity,
      valuesBySlug: { name: `${run.label} Meridian` },
    });
    const dealRecordId = await createEntityRecord({
      entity: dealEntity,
      valuesBySlug: { title: `${run.label} Meridian` },
    });

    const matches = await search(`${run.label} meridian`);
    expect(matches.map((m) => m.record_id).sort()).toEqual(
      [clientRecordId, dealRecordId].sort(),
    );
    expect(new Set(matches.map((m) => m.entity_type_id))).toEqual(
      new Set([clientEntity.id, dealEntity.id]),
    );
  });

  it("the object-type filter restricts matches to one entity type", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const clientEntity = await createEntity(admin, run, "Search Filter Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const dealEntity = await createEntity(admin, run, "Search Filter Deal", [
      { slug: "title", name: "Title", type: "text", required: true },
    ]);
    await setDisplayField(clientEntity, clientEntity.fields.name.id);
    await setDisplayField(dealEntity, dealEntity.fields.title.id);
    await createEntityRecord({ entity: clientEntity, valuesBySlug: { name: `${run.label} Filtered` } });
    await createEntityRecord({ entity: dealEntity, valuesBySlug: { title: `${run.label} Filtered` } });

    const matches = await search(`${run.label} filtered`, { entityTypeId: clientEntity.id });
    expect(matches.every((m) => m.entity_type_id === clientEntity.id)).toBe(true);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("treats a literal % as text, not a wildcard", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const entity = await createEntity(admin, run, "Search Literal Percent", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    await setDisplayField(entity, entity.fields.name.id);

    const literalId = await createEntityRecord({
      entity,
      valuesBySlug: { name: `${run.label} 50% off` },
    });
    await createEntityRecord({
      entity,
      valuesBySlug: { name: `${run.label} 50X off` },
    });

    // A naive unescaped LIKE '%50%%' would also match "50X" (the "%"
    // wildcard swallowing the literal character); only the literal-percent
    // record should match.
    const matches = await search(`${run.label} 50%`);
    expect(matches.map((m) => m.record_id)).toEqual([literalId]);
  });

  it("treats a literal _ as text, not a single-character wildcard", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const entity = await createEntity(admin, run, "Search Literal Underscore", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    await setDisplayField(entity, entity.fields.name.id);

    const literalId = await createEntityRecord({
      entity,
      valuesBySlug: { name: `${run.label} job_id 42` },
    });
    await createEntityRecord({
      entity,
      // An unescaped "_" would match ANY single character here too, e.g.
      // "jobXid" -- only the literal-underscore record should match.
      valuesBySlug: { name: `${run.label} jobXid 42` },
    });

    const matches = await search(`${run.label} job_id`);
    expect(matches.map((m) => m.record_id)).toEqual([literalId]);
  });

  it("treats a literal backslash as text, not an escape character", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const entity = await createEntity(admin, run, "Search Literal Backslash", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    await setDisplayField(entity, entity.fields.name.id);

    const literalId = await createEntityRecord({
      entity,
      valuesBySlug: { name: `${run.label} C:\\reports\\2026` },
    });

    // An unescaped backslash in the query would either error out or change
    // how the following character is interpreted, rather than matching
    // itself literally.
    const matches = await search(`${run.label} C:\\reports`);
    expect(matches.map((m) => m.record_id)).toEqual([literalId]);
  });

  it("does not require an authenticated session beyond service_role or workspace membership -- an outside member is rejected", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const entity = await createEntity(admin, run, "Search Outsider Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Secret` } });

    const password = `E2E-search-outsider-${randomUUID()}!`;
    const email = `e2e-search-outsider-${randomUUID()}@example.test`;
    const { data: userData, error: userError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (userError || !userData.user) throw new Error(userError?.message ?? "Unable to create outsider.");

    const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
    const outsiderClient = createClient(supabaseUrl, supabasePublishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await outsiderClient.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();

    const result = await outsiderClient.rpc("search_workspace_records_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_query: "secret",
      p_entity_type_id: null,
      p_limit_per_type: 20,
    });
    expect(result.error).not.toBeNull();

    await admin.auth.admin.deleteUser(userData.user.id);
  });
});
