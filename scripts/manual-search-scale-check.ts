// One-off, manually-run scale check for Phase 8D.4's Postgres-pushdown
// Search RPC -- deliberately NOT a Vitest/Playwright spec (not part of
// `npm run test:unit` or `npm run test:e2e`), since a 10,000-row bulk
// fixture is explicitly meant to be exercised outside normal CI. Creates
// and tears down its own disposable entities; does not touch the
// dogfood.worker/dogfood.builder accounts.
//
// Every planted record's name contains the same marker word, so a search
// for it matches the ENTIRE tier's row count, not just a handful -- the
// real stress case for both query time and the per-entity-type cap (the
// RPC must still return at most 20 rows even when thousands match).
//
// Run with: npx tsx scripts/manual-search-scale-check.ts
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { requireE2eEnv } from "../tests/e2e/helpers/env";
import {
  createEntity,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  getE2eWorkspaceAdministratorRoleId,
  type TestEntity,
  type TestRun,
} from "../tests/e2e/helpers/supabase-test-data";

// search_workspace_records_authorized has no service_role bypass by design
// (it's built only for an interactive session) -- bulk fixture writes stay
// on the fast admin/service-role client, but the RPC itself must be called
// as a real authenticated workspace member, exactly as the app does.
async function createAuthenticatedMember() {
  const admin = createSupabaseTestClient();
  const password = `E2E-search-scale-${randomUUID()}!`;
  const email = `e2e-search-scale-${randomUUID()}@example.test`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !userData.user) throw new Error(userError?.message ?? "Unable to create test member.");

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
  return { client, userId: userData.user.id };
}

const TIERS = [100, 1000, 10000];
const INSERT_CHUNK_SIZE = 500;
const MARKER = "scalebenchmarkneedle";

// cleanupE2eRun's shared cleanupEntitiesById issues one unbatched DELETE per
// table for every id in the run -- fine for ordinary E2E/unit fixtures (tens
// to low hundreds of rows), but a single DELETE across 10,000+ rows hit a
// Postgres statement timeout when this script first ran (confirmed
// directly). This tier count is unique to this one-off scale script -- no
// other fixture in this codebase creates anywhere near this many rows -- so
// the fix belongs here, not in the shared helper every other spec relies on.
async function bulkDeleteEntity(supabase: ReturnType<typeof createSupabaseTestClient>, entity: TestEntity) {
  for (;;) {
    const { data: idsToDelete, error: fetchError } = await supabase
      .from("entity_records")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("entity_type_id", entity.id)
      .limit(INSERT_CHUNK_SIZE);
    if (fetchError) throw new Error(`fetch records to delete for ${entity.name}: ${fetchError.message}`);
    if (!idsToDelete || idsToDelete.length === 0) break;

    const { error: deleteError } = await supabase
      .from("entity_records")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .in("id", idsToDelete.map((row) => row.id));
    if (deleteError) throw new Error(`delete records for ${entity.name}: ${deleteError.message}`);
  }

  // entity_types.display_field_definition_id FK-references
  // field_definitions -- clear it before deleting fields, same ordering
  // cleanupEntitiesById uses.
  const { error: clearDisplayFieldError } = await supabase
    .from("entity_types")
    .update({ display_field_definition_id: null })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", entity.id);
  if (clearDisplayFieldError) {
    throw new Error(`clear display field for ${entity.name}: ${clearDisplayFieldError.message}`);
  }

  const { error: fieldError } = await supabase
    .from("field_definitions")
    .delete()
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id);
  if (fieldError) throw new Error(`delete fields for ${entity.name}: ${fieldError.message}`);

  const { error: entityTypeError } = await supabase
    .from("entity_types")
    .delete()
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", entity.id);
  if (entityTypeError) throw new Error(`delete entity type ${entity.name}: ${entityTypeError.message}`);
}

async function bulkInsert(
  supabase: ReturnType<typeof createSupabaseTestClient>,
  run: TestRun,
  entity: TestEntity,
  count: number,
) {
  const nameKey = entity.fields.name.key;
  const notesKey = entity.fields.notes.key;

  for (let start = 0; start < count; start += INSERT_CHUNK_SIZE) {
    const end = Math.min(start + INSERT_CHUNK_SIZE, count);
    const rows = [];
    for (let i = start; i < end; i += 1) {
      rows.push({
        id: randomUUID(),
        workspace_id: DEMO_WORKSPACE_ID,
        entity_type_id: entity.id,
        values: {
          [nameKey]: `${run.label} ${MARKER} ${i}`,
          [notesKey]: `Row ${i} of ${count} for scale tier ${count}.`,
        },
      });
    }
    const { error } = await supabase.from("entity_records").insert(rows);
    if (error) throw new Error(`bulk insert at offset ${start}: ${error.message}`);
  }
}

async function main() {
  const supabase = createSupabaseTestClient();
  const run = createTestRun();
  const { client: memberClient, userId: memberUserId } = await createAuthenticatedMember();
  const createdEntities: TestEntity[] = [];

  try {
    for (const tier of TIERS) {
      const entity = await createEntity(supabase, run, `Search Scale ${tier}`, [
        { slug: "name", name: "Name", type: "text", required: true },
        { slug: "notes", name: "Notes", type: "text" },
      ]);
      createdEntities.push(entity);
      await supabase.rpc("set_entity_display_field", {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_entity_type_id: entity.id,
        p_field_definition_id: entity.fields.name.id,
      });

      const insertStart = performance.now();
      await bulkInsert(supabase, run, entity, tier);
      const insertMs = performance.now() - insertStart;
      console.log(`\n=== Tier: ${tier} records (${entity.name}) ===`);
      console.log(`Fixture insert: ${insertMs.toFixed(0)}ms for ${tier} rows`);

      const { count: actualCount, error: countError } = await supabase
        .from("entity_records")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", DEMO_WORKSPACE_ID)
        .eq("entity_type_id", entity.id);
      if (countError) throw new Error(countError.message);
      if (actualCount !== tier) {
        throw new Error(`Expected ${tier} rows for this tier, found ${actualCount}`);
      }

      // The query every record in this tier matches -- the real stress
      // case: the RPC must still identify the whole candidate set, rank
      // it, and return only the top 20.
      const searchStart = performance.now();
      const { data, error } = await memberClient.rpc("search_workspace_records_authorized", {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_query: `${run.label} ${MARKER}`,
        p_entity_type_id: null,
        p_limit_per_type: 20,
      });
      const searchMs = performance.now() - searchStart;
      if (error) throw new Error(error.message);

      const rows = data ?? [];
      const forThisEntity = rows.filter((row: { entity_type_id: string }) => row.entity_type_id === entity.id);
      const payloadBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");

      console.log(`Search RPC (all ${tier} rows match): ${searchMs.toFixed(1)}ms`);
      console.log(`Returned rows for this tier: ${forThisEntity.length} (expect 20, capped in SQL)`);
      console.log(`Total returned rows across all tiers searched so far: ${rows.length}`);
      console.log(`Payload size: ${(payloadBytes / 1024).toFixed(2)} KB`);

      if (forThisEntity.length !== 20) {
        throw new Error(
          `Expected the per-entity-type cap to hold at exactly 20 with ${tier} matches, got ${forThisEntity.length}`,
        );
      }

      // A non-matching query should be fast too (no candidate rows to rank
      // at all) -- confirms cost tracks matching work, not table size.
      const missStart = performance.now();
      const { error: missError } = await memberClient.rpc("search_workspace_records_authorized", {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_query: `${run.label} nonexistentmarkerxyz`,
        p_entity_type_id: null,
        p_limit_per_type: 20,
      });
      const missMs = performance.now() - missStart;
      if (missError) throw new Error(missError.message);
      console.log(`Search RPC (no match, same tier present): ${missMs.toFixed(1)}ms`);
    }

    console.log("\nPASS: search stayed bounded (<=20 rows per entity type) and payload-sized at every tier.");
  } finally {
    console.log("\nCleaning up (chunked -- a single unbatched delete times out past a few thousand rows)...");
    for (const entity of createdEntities) {
      await bulkDeleteEntity(supabase, entity);
      console.log(`  removed ${entity.name}`);
    }
    await supabase.auth.admin.deleteUser(memberUserId);
    console.log(`Cleaned up fixture run ${run.label}.`);
  }
}

main().catch((error) => {
  console.error("FAIL:", error);
  process.exitCode = 1;
});
