import { randomUUID } from "node:crypto";
import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestRun,
} from "./helpers/supabase-test-data";

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];
const workspaceIds: string[] = [];
// api_keys are pure workspace-level rows with no entity_type_id -- outside
// cleanupEntitiesById's purview (the same class of gap workspace_events/
// notifications had before an explicit cleanup step was added for them,
// see PROJECT_CONTEXT.md's 8D.2 section). Tracked and deleted explicitly.
const apiKeyIds: string[] = [];

// A genuinely cookie-less request context, deliberately NOT the injected
// `request` fixture -- that fixture inherits this project's global
// storageState (playwright.config.ts's top-level `use.storageState`,
// applied to `page` AND `request` alike), so it silently carries the
// e2e-runner's session cookie on every call. An /api/v1 caller is external
// by definition and has no session cookie at all; a test that rides along
// on one isn't actually exercising that path -- confirmed the hard way
// during dogfood, where a real cookie-less curl call caught a bug (proxy.ts
// redirecting unauthenticated /api/v1 and /api/internal requests to
// /sign-in before their own bearer-auth ever ran) that this file's first
// draft, using the ambient `request` fixture, did not catch.
let apiContext: APIRequestContext;

test.beforeAll(async () => {
  await cleanupStaleE2eData();
  apiContext = await playwrightRequest.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100" });
});

test.afterAll(async () => {
  await apiContext.dispose();
  const admin = createSupabaseTestClient();
  if (apiKeyIds.length > 0) {
    const { error } = await admin.from("api_keys").delete().in("id", apiKeyIds);
    if (error) throw new Error(error.message);
  }
  for (const run of runs) {
    await cleanupE2eRun(run);
  }
  if (workspaceIds.length > 0) {
    const { error } = await admin.from("workspaces").delete().in("id", workspaceIds);
    if (error) throw new Error(error.message);
  }
});

function scenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function createApiKeyViaUi(page: Page, name: string): Promise<string> {
  await page.goto("/settings/integrations");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("e.g. Reporting integration").fill(name);
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByText("API key -- shown once")).toBeVisible();
  const secret = await page.locator("code").last().textContent();
  if (!secret) throw new Error("API key secret was not rendered.");

  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("api_keys")
    .select("id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("name", name)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not find the newly created key for cleanup tracking.");
  apiKeyIds.push(data.id);

  return secret.trim();
}

async function getApi(request: APIRequestContext, path: string, rawKey: string) {
  return request.get(path, { headers: { authorization: `Bearer ${rawKey}` } });
}

test("create key through the UI, shown once, then exercise the full /api/v1 surface end to end", async ({ page }) => {
  const run = scenarioRun();
  const admin = createSupabaseTestClient();

  const target = await createEntity(admin, run, "Api Client", [{ slug: "name", name: "Name", type: "text", required: true }]);
  const acmeId = await createEntityRecord({ entity: target, valuesBySlug: { name: `${run.label} Acme Corp` } });

  const source = await createEntity(admin, run, "Api Deal", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "notes", name: "Notes", type: "text" },
    { slug: "client", name: "Client", type: "relation", relatedEntityTypeId: target.id },
  ]);

  const activeIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const relations: Record<string, string> = i === 0 ? { client: acmeId } : {};
    const id = await createEntityRecord({
      entity: source,
      valuesBySlug: { name: `${run.label} Deal ${i}`, notes: "internal" },
      relationsBySlug: relations,
    });
    activeIds.push(id);
  }
  const archivedRecordId = await createEntityRecord({ entity: source, valuesBySlug: { name: `${run.label} Archived Deal` } });
  await admin.from("entity_records").update({ archived_at: new Date().toISOString() }).eq("id", archivedRecordId);
  await admin.from("field_definitions").update({ archived_at: new Date().toISOString() }).eq("id", source.fields.notes.id);

  // 1. Create key through the UI; secret shown once.
  const rawKey = await createApiKeyViaUi(page, `${run.label} Full Flow Key`);
  expect(rawKey).toMatch(/^kinema_live_[0-9a-f]{64}$/);

  // 2. GET /api/v1/objects -- the newly created object types appear; every
  // response carries the no-store cache posture.
  const objectsRes = await getApi(apiContext, "/api/v1/objects?limit=200", rawKey);
  expect(objectsRes.status()).toBe(200);
  expect(objectsRes.headers()["cache-control"]).toBe("private, no-store");
  const objectsBody = await objectsRes.json();
  const ids = objectsBody.data.map((o: { id: string }) => o.id);
  expect(ids).toContain(source.id);
  expect(ids).toContain(target.id);

  // 3. GET /api/v1/objects/:entityTypeId -- active fields only (notes is archived).
  const objectRes = await getApi(apiContext, `/api/v1/objects/${source.id}`, rawKey);
  expect(objectRes.status()).toBe(200);
  const objectBody = await objectRes.json();
  const fieldKeys = objectBody.fields.map((f: { key: string }) => f.key);
  expect(fieldKeys).toContain(source.fields.name.key);
  expect(fieldKeys).toContain(source.fields.client.key);
  expect(fieldKeys).not.toContain(source.fields.notes.key);

  // 4. GET .../records -- truthful cursor pagination, archived record and
  // archived field excluded, relation resolved as {id, label}.
  const page1 = await getApi(apiContext, `/api/v1/objects/${source.id}/records?limit=3`, rawKey);
  expect(page1.status()).toBe(200);
  const page1Body = await page1.json();
  expect(page1Body.data).toHaveLength(3);
  expect(page1Body.nextCursor).not.toBeNull();
  const expectedKeys = [source.fields.name.key, source.fields.client.key].sort();
  for (const record of page1Body.data) {
    expect(Object.keys(record.values).sort()).toEqual(expectedKeys);
  }
  expect(page1Body.data[0].values[source.fields.client.key]).toEqual({ id: acmeId, label: `${run.label} Acme Corp` });

  const page2 = await getApi(
    apiContext,
    `/api/v1/objects/${source.id}/records?limit=3&cursor=${encodeURIComponent(page1Body.nextCursor)}`,
    rawKey,
  );
  const page2Body = await page2.json();
  expect(page2Body.data).toHaveLength(2); // only 2 remain -- genuinely terminal
  expect(page2Body.nextCursor).toBeNull();

  const allRecordIds = [...page1Body.data, ...page2Body.data].map((r: { id: string }) => r.id);
  expect(new Set(allRecordIds).size).toBe(5);
  expect(allRecordIds.sort()).toEqual([...activeIds].sort());
  expect(allRecordIds).not.toContain(archivedRecordId);

  // 5. GET .../records/:recordId -- single record detail.
  const recordRes = await getApi(apiContext, `/api/v1/objects/${source.id}/records/${activeIds[0]}`, rawKey);
  expect(recordRes.status()).toBe(200);
  const recordBody = await recordRes.json();
  expect(recordBody.values[source.fields.client.key]).toEqual({ id: acmeId, label: `${run.label} Acme Corp` });
  expect(recordBody.values).not.toHaveProperty(source.fields.notes.key);

  // 6. Archived record/object detail routes 404, with the no-store header
  // present on error responses too.
  const archivedRecordRes = await getApi(apiContext, `/api/v1/objects/${source.id}/records/${archivedRecordId}`, rawKey);
  expect(archivedRecordRes.status()).toBe(404);
  expect(archivedRecordRes.headers()["cache-control"]).toBe("private, no-store");

  // 7. Foreign-workspace ids: a real entity type in a different workspace
  // is indistinguishable from "doesn't exist" -- uniform 404.
  const foreignWorkspaceId = randomUUID();
  workspaceIds.push(foreignWorkspaceId);
  await admin.from("workspaces").insert({ id: foreignWorkspaceId, name: `Foreign ${foreignWorkspaceId.slice(0, 8)}` });
  const foreignEntityTypeId = randomUUID();
  await admin.from("entity_types").insert({
    id: foreignEntityTypeId, workspace_id: foreignWorkspaceId, name: "Foreign Object", slug: `foreign-${foreignEntityTypeId.slice(0, 8)}`,
  });
  const foreignRes = await getApi(apiContext, `/api/v1/objects/${foreignEntityTypeId}`, rawKey);
  expect(foreignRes.status()).toBe(404);

  // 8. Revoke via the UI; the key stops working immediately.
  await page.goto("/settings/integrations");
  await page.waitForLoadState("networkidle");
  await page
    .locator("li", { hasText: `${run.label} Full Flow Key` })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(page.getByText("API key revoked.")).toBeVisible();

  const revokedRes = await getApi(apiContext, "/api/v1/objects", rawKey);
  expect(revokedRes.status()).toBe(401);
  const revokedBody = await revokedRes.json();
  expect(revokedBody.error.code).toBe("invalid_api_key");
});

test("rate limiting: the 61st request in a window is rejected, and the rejection itself is durable", async ({ page }) => {
  test.setTimeout(60_000);
  const run = scenarioRun();
  const rawKey = await createApiKeyViaUi(page, `${run.label} Rate Limit Key`);

  let lastStatus = 0;
  let lastHeaders: Record<string, string> = {};
  for (let i = 0; i < 61; i++) {
    const res = await getApi(apiContext, "/api/v1/objects?limit=1", rawKey);
    lastStatus = res.status();
    lastHeaders = res.headers();
  }

  expect(lastStatus).toBe(429);
  expect(lastHeaders["retry-after"]).toBe("60");
  expect(lastHeaders["cache-control"]).toBe("private, no-store");

  // A fresh request against the same key still reports 429 -- the counter
  // state that produced the rejection was committed, not rolled back.
  const followUp = await getApi(apiContext, "/api/v1/objects", rawKey);
  expect(followUp.status()).toBe(429);
});
