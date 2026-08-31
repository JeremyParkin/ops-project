// DB/RPC-level coverage for Phase 8F.3 Read-only API Foundations: key
// creation and hash-only storage, valid/invalid/revoked verification,
// cross-workspace isolation, scope enforcement, bounded/cursor-paginated
// record reads, archived exclusion, relation label resolution, and the
// rate-limiter's commit behavior under rejection (the specific transaction
// bug this migration was revised to avoid: a rejected request's counter
// mutation must still commit). Requires migration 0074 applied.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";
import { apiKeyPreview, generateApiKey, hashApiKey } from "./api-key-signing";

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
  const password = `ApiKey-${randomUUID()}!`;
  const email = `e2e-apikey-${label}-${randomUUID()}@example.test`;
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

async function memberWithCapabilities(workspaceId: string, capabilities: string[]) {
  const user = await createUser(capabilities.length ? "with-cap" : "no-cap");
  const roleId = await createRole(workspaceId, `Role ${randomUUID().slice(0, 8)}`, capabilities);
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: user.id, role_id: roleId });
  if (error) throw new Error(error.message);
  return authenticatedClient(user);
}

async function issueApiKey(builder: SupabaseClient, workspaceId: string, name: string) {
  const rawKey = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const { data, error } = await builder.rpc("create_api_key_authorized", {
    p_workspace_id: workspaceId,
    p_name: name,
    p_key_hash: keyHash,
    p_key_preview: apiKeyPreview(rawKey),
  });
  if (error || !data?.[0]) throw new Error(error?.message ?? "create_api_key_authorized returned no row.");
  return { rawKey, keyHash, keyId: data[0].id as string };
}

describe("API key creation and storage", () => {
  it("creates a key gated on workspace.manage_integrations and stores only the hash, never the raw key", async () => {
    const workspaceId = await createWorkspace("Api Key Create");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const viewer = await memberWithCapabilities(workspaceId, ["operations.view"]);
    const admin = createSupabaseTestClient();

    const { rawKey, keyHash, keyId } = await issueApiKey(builder, workspaceId, "Reporting key");

    const { data: row, error } = await admin.from("api_keys").select("*").eq("id", keyId).single();
    expect(error).toBeNull();
    expect(row?.key_hash).toBe(keyHash);
    expect(row?.key_preview).toBe(rawKey.slice(-4));
    expect(JSON.stringify(row)).not.toContain(rawKey);
    expect(row?.scopes).toEqual(["records:read"]);
    expect(row?.revoked_at).toBeNull();

    const { data: rateRow } = await admin.from("api_key_rate_limits").select("api_key_id").eq("api_key_id", keyId).maybeSingle();
    expect(rateRow).not.toBeNull();

    const { error: viewerError } = await viewer.rpc("create_api_key_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Should fail",
      p_key_hash: hashApiKey(generateApiKey()),
      p_key_preview: "0000",
    });
    expect(viewerError?.message).toContain("workspace.manage_integrations");
  });
});

describe("check_api_key_rate_limit_for_api_key", () => {
  it("resolves a valid key and rejects an unknown or revoked one", async () => {
    const workspaceId = await createWorkspace("Api Key Verify");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();
    const { keyHash, keyId } = await issueApiKey(builder, workspaceId, "Verify key");

    const { data: ok, error: okError } = await admin.rpc("check_api_key_rate_limit_for_api_key", { p_key_hash: keyHash });
    expect(okError).toBeNull();
    expect(ok?.[0].workspace_id).toBe(workspaceId);
    expect(ok?.[0].allowed).toBe(true);

    const { error: unknownError } = await admin.rpc("check_api_key_rate_limit_for_api_key", { p_key_hash: hashApiKey("nope") });
    expect(unknownError?.message).toContain("invalid_api_key");

    await builder.rpc("revoke_api_key_authorized", { p_workspace_id: workspaceId, p_key_id: keyId });
    const { error: revokedError } = await admin.rpc("check_api_key_rate_limit_for_api_key", { p_key_hash: keyHash });
    expect(revokedError?.message).toContain("invalid_api_key");
  });

  it("commits the counter mutation even on the request that gets rejected for exceeding the limit", async () => {
    const workspaceId = await createWorkspace("Api Key Rate Limit");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();
    const { keyHash, keyId } = await issueApiKey(builder, workspaceId, "Rate limited key");

    let lastResult: { allowed: boolean } | undefined;
    for (let i = 0; i < 61; i++) {
      const { data, error } = await admin.rpc("check_api_key_rate_limit_for_api_key", { p_key_hash: keyHash });
      expect(error).toBeNull();
      lastResult = data?.[0];
    }

    expect(lastResult?.allowed).toBe(false);

    const { data: rateRow } = await admin.from("api_key_rate_limits").select("request_count").eq("api_key_id", keyId).single();
    expect(rateRow?.request_count).toBe(61);

    const { data: keyRow } = await admin.from("api_keys").select("last_used_at").eq("id", keyId).single();
    expect(keyRow?.last_used_at).not.toBeNull();
    expect(Date.now() - new Date(keyRow!.last_used_at).getTime()).toBeLessThan(30_000);
  }, 30_000);
});

describe("data RPCs: isolation, scope, and bounded reads", () => {
  it("never returns another workspace's object even when its real id is guessed", async () => {
    const workspaceA = await createWorkspace("Api Key Isolation A");
    const workspaceB = await createWorkspace("Api Key Isolation B");
    const builderA = await memberWithCapabilities(workspaceA, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();
    const { keyHash } = await issueApiKey(builderA, workspaceA, "Isolation key");

    const foreignEntityTypeId = randomUUID();
    const { error: foreignError } = await admin
      .from("entity_types")
      .insert({ id: foreignEntityTypeId, workspace_id: workspaceB, name: "Foreign Object", slug: `foreign-${foreignEntityTypeId.slice(0, 8)}` });
    expect(foreignError).toBeNull();

    const { data: objects } = await admin.rpc("list_objects_for_api_key", { p_key_hash: keyHash, p_limit: 200 });
    expect(objects?.some((row: { id: string }) => row.id === foreignEntityTypeId)).toBe(false);

    const { data: singleObject } = await admin.rpc("get_object_for_api_key", { p_key_hash: keyHash, p_entity_type_id: foreignEntityTypeId });
    expect(singleObject).toEqual([]);
  });

  it("list_objects_for_api_key also over-fetches by one to make nextCursor truthful", async () => {
    const workspaceId = await createWorkspace("Api Key Objects Pagination");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations", "schema.manage"]);
    const admin = createSupabaseTestClient();
    const { keyHash } = await issueApiKey(builder, workspaceId, "Objects pagination key");

    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      await admin.from("entity_types").insert({ id, workspace_id: workspaceId, name: `Object ${i}`, slug: `object-${id.slice(0, 8)}` });
    }

    const { data: overFetched, error } = await admin.rpc("list_objects_for_api_key", { p_key_hash: keyHash, p_limit: 2 });
    expect(error).toBeNull();
    expect(overFetched).toHaveLength(3); // 2 requested + 1 lookahead row

    const { data: exact } = await admin.rpc("list_objects_for_api_key", { p_key_hash: keyHash, p_limit: 3 });
    expect(exact).toHaveLength(3); // exactly 3 exist -- no lookahead row to over-fetch
  });

  it("rejects a key whose scopes no longer include records:read", async () => {
    const workspaceId = await createWorkspace("Api Key Scope");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();
    const { keyHash, keyId } = await issueApiKey(builder, workspaceId, "Scope key");

    const { error: updateError } = await admin.from("api_keys").update({ scopes: [] }).eq("id", keyId);
    expect(updateError).toBeNull();

    const { error } = await admin.rpc("list_objects_for_api_key", { p_key_hash: keyHash, p_limit: 50 });
    expect(error?.message).toContain("insufficient_scope");
  });

  it("returns only active records, excludes archived fields/records, and paginates deterministically without overlap", async () => {
    const workspaceId = await createWorkspace("Api Key Records");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations", "schema.manage", "records.operate"]);
    const admin = createSupabaseTestClient();
    const { keyHash } = await issueApiKey(builder, workspaceId, "Records key");

    const entityTypeId = randomUUID();
    const nameFieldId = randomUUID();
    const archivedFieldId = randomUUID();
    const { error: entityError } = await admin
      .from("entity_types")
      .insert({ id: entityTypeId, workspace_id: workspaceId, name: "Deal", slug: `deal-${entityTypeId.slice(0, 8)}` });
    expect(entityError).toBeNull();
    const { error: fieldsError } = await admin.from("field_definitions").insert([
      { id: nameFieldId, workspace_id: workspaceId, entity_type_id: entityTypeId, key: "name", name: "Name", slug: "name", type: "text", required: true, position: 1 },
      { id: archivedFieldId, workspace_id: workspaceId, entity_type_id: entityTypeId, key: "notes", name: "Notes", slug: "notes", type: "text", required: false, position: 2, archived_at: new Date().toISOString() },
    ]);
    expect(fieldsError).toBeNull();

    const activeIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      activeIds.push(id);
      const { error } = await admin
        .from("entity_records")
        .insert({ id, workspace_id: workspaceId, entity_type_id: entityTypeId, values: { name: `Record ${i}`, notes: "hidden" } });
      expect(error).toBeNull();
    }
    const archivedRecordId = randomUUID();
    await admin.from("entity_records").insert({
      id: archivedRecordId, workspace_id: workspaceId, entity_type_id: entityTypeId, values: { name: "Archived Record" }, archived_at: new Date().toISOString(),
    });

    // The RPC's own contract is "limit + 1" (see migration 0074) so the app
    // layer can tell a genuine next page from a coincidental exact-multiple
    // last page -- trimming to the declared limit is buildApiPage's job
    // (lib/domain/api-cursor.ts), not the RPC's. Calling the RPC directly
    // here (bypassing that trimming layer) is deliberate: it's the only way
    // to assert the over-fetch itself is real.
    const { data: firstPage, error: firstError } = await admin.rpc("list_records_for_api_key", {
      p_key_hash: keyHash, p_entity_type_id: entityTypeId, p_limit: 3, p_after_created_at: null, p_after_id: null,
    });
    expect(firstError).toBeNull();
    expect(firstPage).toHaveLength(4); // 3 requested + 1 lookahead row proving a next page exists
    for (const row of firstPage) {
      expect(row.record_values.notes).toBeUndefined();
      expect(Object.keys(row.record_values)).toEqual(["name"]);
    }

    const pageOneTrimmed = firstPage.slice(0, 3);
    const last = pageOneTrimmed[pageOneTrimmed.length - 1];
    const { data: secondPage, error: secondError } = await admin.rpc("list_records_for_api_key", {
      p_key_hash: keyHash, p_entity_type_id: entityTypeId, p_limit: 3, p_after_created_at: last.created_at, p_after_id: last.id,
    });
    expect(secondError).toBeNull();
    // Only 2 records remain after the first 3 -- no lookahead row exists,
    // so this comes back at exactly 2, not 3, proving the over-fetch only
    // ever returns rows that are actually there.
    expect(secondPage).toHaveLength(2);

    const allIds = [...pageOneTrimmed, ...secondPage].map((row: { id: string }) => row.id);
    expect(new Set(allIds).size).toBe(5);
    expect(allIds.sort()).toEqual([...activeIds].sort());
    expect(allIds).not.toContain(archivedRecordId);
  });

  it("resolves a relation field's value as { id, label } using the target's canonical display label", async () => {
    const workspaceId = await createWorkspace("Api Key Relation");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations", "schema.manage", "records.operate"]);
    const admin = createSupabaseTestClient();
    const { keyHash } = await issueApiKey(builder, workspaceId, "Relation key");

    const targetTypeId = randomUUID();
    const targetNameFieldId = randomUUID();
    await admin.from("entity_types").insert({ id: targetTypeId, workspace_id: workspaceId, name: "Client", slug: `client-${targetTypeId.slice(0, 8)}` });
    await admin.from("field_definitions").insert({
      id: targetNameFieldId, workspace_id: workspaceId, entity_type_id: targetTypeId, key: "name", name: "Name", slug: "name", type: "text", required: true, position: 1,
    });
    const targetRecordId = randomUUID();
    await admin.from("entity_records").insert({ id: targetRecordId, workspace_id: workspaceId, entity_type_id: targetTypeId, values: { name: "Acme Corp" } });

    const sourceTypeId = randomUUID();
    const clientFieldId = randomUUID();
    await admin.from("entity_types").insert({ id: sourceTypeId, workspace_id: workspaceId, name: "Deal", slug: `deal-rel-${sourceTypeId.slice(0, 8)}` });
    await admin.from("field_definitions").insert({
      id: clientFieldId, workspace_id: workspaceId, entity_type_id: sourceTypeId, key: "client", name: "Client", slug: "client", type: "relation", related_entity_type_id: targetTypeId, required: false, position: 1,
    });
    const sourceRecordId = randomUUID();
    // Deliberately NOT `values: { client: targetRecordId }` -- Kinema never
    // stores a relation's target id in entity_records.values, only in the
    // normalized entity_record_relation_values table. This fixture would
    // have silently masked the exact bug caught in pre-migration review if
    // it embedded the relation in `values` the way a naive assumption
    // (mirrored by the RPC's first, incorrect draft) would expect.
    await admin.from("entity_records").insert({ id: sourceRecordId, workspace_id: workspaceId, entity_type_id: sourceTypeId, values: {} });
    const { error: relationError } = await admin.from("entity_record_relation_values").insert({
      workspace_id: workspaceId,
      source_entity_type_id: sourceTypeId,
      source_record_id: sourceRecordId,
      field_definition_id: clientFieldId,
      target_entity_type_id: targetTypeId,
      target_record_id: targetRecordId,
    });
    expect(relationError).toBeNull();

    const { data, error } = await admin.rpc("get_record_for_api_key", {
      p_key_hash: keyHash, p_entity_type_id: sourceTypeId, p_record_id: sourceRecordId,
    });
    expect(error).toBeNull();
    expect(data?.[0].record_values.client).toEqual({ id: targetRecordId, label: "Acme Corp" });
  });
});

describe("revoke_api_key_authorized", () => {
  it("rejects revoking an already-revoked key", async () => {
    const workspaceId = await createWorkspace("Api Key Revoke Twice");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const { keyId } = await issueApiKey(builder, workspaceId, "Double revoke key");

    const { error: firstError } = await builder.rpc("revoke_api_key_authorized", { p_workspace_id: workspaceId, p_key_id: keyId });
    expect(firstError).toBeNull();

    const { error: secondError } = await builder.rpc("revoke_api_key_authorized", { p_workspace_id: workspaceId, p_key_id: keyId });
    expect(secondError?.message).toContain("not found or already revoked");
  });
});
