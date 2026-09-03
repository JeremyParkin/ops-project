import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { requireE2eEnv } from "./env";

export const DEMO_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const E2E_NAME_PREFIX = "E2E";

const E2E_ADMIN_CAPABILITIES = [
  "workspace.manage_members",
  "workspace.manage_roles",
  "workspace.manage_organization",
  "workspace.manage_settings",
  "schema.manage",
  "automation.manage",
  "records.operate",
  "processes.operate",
  "operations.view",
];

type FieldInput = {
  slug: string;
  name: string;
  type: "text" | "number" | "date" | "boolean" | "relation";
  required?: boolean;
  relatedEntityTypeId?: string;
};

export type TestField = FieldInput & {
  id: string;
  key: string;
  position: number;
};

export type TestEntity = {
  id: string;
  name: string;
  slug: string;
  fields: Record<string, TestField>;
};

export type TestRun = {
  id: string;
  label: string;
};

export type WorkflowFixture = {
  client: TestEntity;
  deliverable: TestEntity;
  task: TestEntity;
  clientRecordId: string;
};

export type RecordUpdatedFixture = {
  client: TestEntity;
  ticket: TestEntity;
  activity: TestEntity;
  firstClientRecordId: string;
  secondClientRecordId: string;
};

export type RelatedRecordWorkflowFixture = {
  client: TestEntity;
  deliverable: TestEntity;
  firstClientRecordId: string;
  secondClientRecordId: string;
};

type SupabaseClient = ReturnType<typeof createSupabaseTestClient>;

export function createTestRun(): TestRun {
  const suffix = randomUUID().slice(0, 8);

  return {
    id: suffix,
    label: `${E2E_NAME_PREFIX} ${suffix}`,
  };
}

// Narrow retry policy for test-infrastructure calls only (this file's own
// Supabase traffic) -- never for product requests or assertions. Retries
// only network-level transport failures and 5xx responses; 4xx, auth/
// permission errors, and Postgres logical/constraint errors are never
// retried and surface immediately -- a real authorization bug should fail
// loudly, not be silently masked by a retry. `JWT issued at future` is a
// deliberate, narrow exception to that rule: it is not a permission or
// credential problem, it is GoTrue rejecting a token whose `iat` looks
// later than the server's own clock, caused entirely by transient skew
// between this host's clock and the remote Supabase project's -- the exact
// same environmental class as the transport failures below, just surfaced
// through an auth-shaped error message. Confirmed transient twice in one
// session (different files, both times clean on an immediate rerun with no
// code change). Small, bounded attempt count; every retry is logged so
// flakiness stays visible even when the operation ultimately succeeds.
const MAX_INFRA_ATTEMPTS = 3;
const INFRA_RETRY_BACKOFF_MS = [250, 750];
const RETRYABLE_MESSAGE_PATTERNS = [
  /fetch failed/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /UND_ERR_CONNECT_TIMEOUT/,
  /UND_ERR_SOCKET/,
  /socket hang up/i,
  /network error/i,
  /JWT issued at future/i,
];

type InfraError = { message?: string; status?: number } | null | undefined;

// Exported for direct unit-style validation of the classification policy
// (see the retry-classification check run during hardening validation);
// not otherwise meant for use outside this module.
export function isRetryableInfraError(error: InfraError): boolean {
  if (!error) return false;
  if (typeof error.status === "number" && error.status >= 500 && error.status < 600) {
    return true;
  }
  return RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(error.message ?? ""));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generic over the result shape via an explicit error accessor, rather than
// a fixed `{data, error}` type: Postgrest responses and GoTrue admin
// responses both carry an `error`, but GoTrue's are discriminated unions
// (data.user is `User` on success, `null` on failure) that don't unify
// cleanly with a single generic shape, and Postgrest's query builders are
// thenables (not literal Promises), so `operation` is typed as
// `PromiseLike` to accept them directly without an extra `await`.
async function withInfraRetry<R>(
  operation: () => PromiseLike<R>,
  label: string,
  getError: (result: R) => InfraError,
): Promise<R> {
  let attempt = 1;

  for (;;) {
    const result = await operation();
    const error = getError(result);

    if (!error || !isRetryableInfraError(error) || attempt >= MAX_INFRA_ATTEMPTS) {
      return result;
    }

    const delay = INFRA_RETRY_BACKOFF_MS[attempt - 1] ?? INFRA_RETRY_BACKOFF_MS.at(-1)!;
    console.warn(
      `[e2e-retry] ${label}: attempt ${attempt} failed (${error.message}), retrying in ${delay}ms`,
    );
    await sleep(delay);
    attempt += 1;
  }
}

export function createSupabaseTestClient() {
  const { supabaseUrl, supabaseSecretKey } = requireE2eEnv();

  const client = createClient(supabaseUrl, supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  // Transparent retry for the Auth Admin API specifically -- this is where
  // the transient `fetch failed` flakes have actually been observed (both
  // during fixture setup and, especially, during afterAll cleanup). Wrapping
  // here means every existing call site across the suite gets the same
  // narrow retry policy with no call-site changes, and the {data, error}
  // contract callers already check is preserved exactly.
  const originalCreateUser = client.auth.admin.createUser.bind(client.auth.admin);
  const originalDeleteUser = client.auth.admin.deleteUser.bind(client.auth.admin);
  const originalListUsers = client.auth.admin.listUsers.bind(client.auth.admin);

  client.auth.admin.createUser = ((...args: Parameters<typeof originalCreateUser>) =>
    withInfraRetry(() => originalCreateUser(...args), "auth.admin.createUser", (r) => r.error)) as typeof originalCreateUser;
  client.auth.admin.deleteUser = ((...args: Parameters<typeof originalDeleteUser>) =>
    withInfraRetry(() => originalDeleteUser(...args), "auth.admin.deleteUser", (r) => r.error)) as typeof originalDeleteUser;
  client.auth.admin.listUsers = ((...args: Parameters<typeof originalListUsers>) =>
    withInfraRetry(() => originalListUsers(...args), "auth.admin.listUsers", (r) => r.error)) as typeof originalListUsers;

  return client;
}

// Deletes every user in userIds, attempting all of them even if earlier ones
// fail (after their own retries are exhausted) -- a persistent failure
// deleting one disposable test user should not prevent cleanup of the rest.
// Every failure is collected and reported together; nothing is silently
// dropped. Pass an existing client to avoid constructing a redundant one.
export async function deleteE2eUsers(
  userIds: string[],
  client?: SupabaseClient,
): Promise<void> {
  const supabase = client ?? createSupabaseTestClient();
  const failures: string[] = [];

  for (const userId of userIds) {
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) {
      failures.push(`${userId}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Unable to delete ${failures.length} E2E user(s):\n${failures.join("\n")}`);
  }
}

export async function getE2eWorkspaceAdministratorRoleId(
  supabase: SupabaseClient,
  workspaceId: string,
) {
  const { data, error } = await withInfraRetry(
    () =>
      supabase
        .from("workspace_roles")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("is_builtin", true)
        .single(),
    "load the workspace administrator role",
    (r) => r.error,
  );
  if (error || !data) throw new Error(error?.message ?? "Unable to load the workspace administrator role.");
  return data.id;
}

export async function createE2eWorkspaceAdministratorRole(
  supabase: SupabaseClient,
  workspaceId: string,
) {
  const roleId = randomUUID();
  await throwOnError(
    () =>
      supabase.from("workspace_roles").insert({
        id: roleId,
        workspace_id: workspaceId,
        name: "E2E workspace administrator",
        is_builtin: true,
      }),
    "create E2E workspace administrator role",
  );
  await throwOnError(
    () =>
      supabase.from("workspace_role_capabilities").insert(
        E2E_ADMIN_CAPABILITIES.map((capability) => ({
          workspace_id: workspaceId,
          role_id: roleId,
          capability,
        })),
      ),
    "grant E2E workspace administrator capabilities",
  );
  return roleId;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function createField(run: TestRun, entitySlug: string, input: FieldInput, index: number) {
  return {
    ...input,
    id: randomUUID(),
    key: `fld_e2e_${run.id}_${entitySlug}_${input.slug}`.replace(/-/g, "_"),
    position: index + 1,
  };
}

async function throwOnError<T>(
  operation: () => PromiseLike<{ data: T; error: InfraError }>,
  action: string,
) {
  const result = await withInfraRetry(operation, action, (r) => r.error);

  if (result.error) {
    throw new Error(`${action}: ${result.error.message}`);
  }

  return result.data;
}

// Runs a cleanup step (already retried for transient failures by
// throwOnError/withInfraRetry) and, if it still fails, records the failure
// into `failures` and continues rather than aborting the remaining steps --
// a persistent failure removing one class of disposable fixture data should
// not prevent cleanup of everything else that can still be removed. Nothing
// is silently dropped: the caller is expected to throw once all steps have
// been attempted if `failures` is non-empty.
async function attemptCleanupStep(
  step: () => Promise<unknown>,
  failures: string[],
) {
  try {
    await step();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

function throwAggregatedCleanupFailures(context: string, failures: string[]) {
  if (failures.length > 0) {
    throw new Error(
      `${context}: ${failures.length} cleanup step(s) failed after attempting all of them:\n${failures.join("\n")}`,
    );
  }
}

export async function cleanupStaleE2eData() {
  const supabase = createSupabaseTestClient();
  const failures: string[] = [];

  // The current prototype uses the development Supabase project, so every E2E
  // artifact is owned by the reserved "E2E " name prefix and can be reset here.
  // A separate Supabase test project or local Supabase should replace this
  // before running these tests in CI.
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("workflows")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .ilike("name", `${E2E_NAME_PREFIX} %`),
        "clean up existing E2E workflows",
      ),
    failures,
  );

  let entityTypeIds: string[] = [];
  await attemptCleanupStep(async () => {
    const staleEntities = await throwOnError(
      () =>
        supabase
          .from("entity_types")
          .select("id")
          .eq("workspace_id", DEMO_WORKSPACE_ID)
          .ilike("name", `${E2E_NAME_PREFIX} %`),
      "find existing E2E entities",
    );
    entityTypeIds = (staleEntities ?? []).map((entity) => entity.id);
  }, failures);

  await attemptCleanupStep(() => cleanupEntitiesById(supabase, entityTypeIds), failures);

  throwAggregatedCleanupFailures("clean up stale E2E data", failures);
}

export async function cleanupE2eRun(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const failures: string[] = [];

  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("workflows")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .ilike("name", `${run.label}%`),
        "clean up E2E workflows",
      ),
    failures,
  );

  let entityTypeIds: string[] = [];
  await attemptCleanupStep(async () => {
    const entities = await throwOnError(
      () =>
        supabase
          .from("entity_types")
          .select("id")
          .eq("workspace_id", DEMO_WORKSPACE_ID)
          .ilike("name", `${run.label}%`),
      "find E2E entities",
    );
    entityTypeIds = (entities ?? []).map((entity) => entity.id);
  }, failures);

  await attemptCleanupStep(() => cleanupEntitiesById(supabase, entityTypeIds), failures);

  throwAggregatedCleanupFailures(`clean up E2E run ${run.label}`, failures);
}

async function cleanupEntitiesById(supabase: SupabaseClient, entityTypeIds: string[]) {
  if (entityTypeIds.length === 0) {
    return;
  }

  const failures: string[] = [];

  // process_runs.origin_record_id and process_templates.applies_to_entity_type_id
  // both carry an ON DELETE RESTRICT foreign key back to entity_types/entity_records
  // (see migration 0027), so both must be cleared before entity_records/entity_types
  // can be deleted below. process_step_runs and process_nodes/process_edges cascade
  // from process_runs/process_templates respectively, so deleting those two is enough.
  // Every step below is still attempted even if an earlier one fails -- a step
  // that genuinely depends on an earlier one will fail too (an FK violation),
  // which is informative rather than harmful, and every independent step still
  // gets its chance to clean up what it can.
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("entity_record_relation_values")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("source_entity_type_id", entityTypeIds),
        "clean up E2E source relation rows",
      ),
    failures,
  );
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("entity_record_relation_values")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("target_entity_type_id", entityTypeIds),
        "clean up E2E target relation rows",
      ),
    failures,
  );
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("entity_types")
            .update({ display_field_definition_id: null })
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("id", entityTypeIds),
        "clear E2E display field references",
      ),
    failures,
  );
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("entity_views")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("entity_type_id", entityTypeIds),
        "clean up E2E saved views",
      ),
    failures,
  );
  // process_recurrence_rules (0063) carries ON DELETE RESTRICT foreign keys
  // back to both process_templates and entity_records, so it must be
  // cleared before either -- and before process_runs, since a rule's
  // occurrences (cascade-deleted with the rule) hold the only reference
  // that would otherwise dangle when a run they started is removed below.
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("process_recurrence_rules")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("origin_entity_type_id", entityTypeIds),
        "clean up E2E recurrence rules",
      ),
    failures,
  );
  // notifications and workspace_events (0064) deliberately carry no foreign
  // keys back to entity_types/process_runs/process_step_runs -- an audit-log
  // table must never block deletion of the business data it describes. That
  // means nothing here cascades them away: without an explicit step they
  // would silently accumulate in the shared dev project across every E2E
  // run. Scoped by entity_type_id, which every notification/event this
  // suite generates carries (assignment/due-soon/overdue all derive it from
  // the triggering ProcessRun's origin record). No ordering constraint
  // relative to the other steps below -- included here only to sit next to
  // the other process-adjacent cleanup.
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("notifications")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("entity_type_id", entityTypeIds),
        "clean up E2E notifications",
      ),
    failures,
  );
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("workspace_events")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("entity_type_id", entityTypeIds),
        "clean up E2E workspace events",
      ),
    failures,
  );
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("process_runs")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("origin_entity_type_id", entityTypeIds),
        "clean up E2E process runs",
      ),
    failures,
  );
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("process_templates")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("applies_to_entity_type_id", entityTypeIds),
        "clean up E2E process templates",
      ),
    failures,
  );
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("record_input_requests")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("entity_type_id", entityTypeIds),
        "clean up E2E record input requests",
      ),
    failures,
  );
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("record_comments")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("entity_type_id", entityTypeIds),
        "clean up E2E record comments",
      ),
    failures,
  );
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("field_definitions")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("entity_type_id", entityTypeIds),
        "clean up E2E field definitions",
      ),
    failures,
  );
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("entity_records")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("entity_type_id", entityTypeIds),
        "clean up E2E records",
      ),
    failures,
  );
  await attemptCleanupStep(
    () =>
      throwOnError(
        () =>
          supabase
            .from("entity_types")
            .delete()
            .eq("workspace_id", DEMO_WORKSPACE_ID)
            .in("id", entityTypeIds),
        "clean up E2E entities",
      ),
    failures,
  );

  throwAggregatedCleanupFailures("clean up E2E entities", failures);
}

export async function createEntity(
  supabase: SupabaseClient,
  run: TestRun,
  nameSuffix: string,
  fieldInputs: FieldInput[],
) {
  const entitySlug = slugify(`${run.label}-${nameSuffix}`);
  const entity: TestEntity = {
    id: randomUUID(),
    name: `${run.label} ${nameSuffix}`,
    slug: entitySlug,
    fields: {},
  };
  const fields = fieldInputs.map((field, index) =>
    createField(run, entitySlug, field, index),
  );

  fields.forEach((field) => {
    entity.fields[field.slug] = field;
  });

  await throwOnError(
    () =>
      supabase.from("entity_types").insert({
        id: entity.id,
        workspace_id: DEMO_WORKSPACE_ID,
        name: entity.name,
        slug: entity.slug,
        description: "Created by automated E2E tests.",
      }),
    `create E2E entity ${entity.name}`,
  );

  await throwOnError(
    () =>
      supabase.from("field_definitions").insert(
        fields.map((field) => ({
          id: field.id,
          workspace_id: DEMO_WORKSPACE_ID,
          entity_type_id: entity.id,
          key: field.key,
          name: field.name,
          slug: field.slug,
          type: field.type,
          related_entity_type_id:
            field.type === "relation" ? field.relatedEntityTypeId : null,
          required: Boolean(field.required),
          position: field.position,
        })),
      ),
    `create E2E fields for ${entity.name}`,
  );

  return entity;
}

export async function createEntityRecord({
  entity,
  valuesBySlug,
  relationsBySlug = {},
}: {
  entity: TestEntity;
  valuesBySlug: Record<string, string | number | boolean | null>;
  relationsBySlug?: Record<string, string>;
}) {
  const supabase = createSupabaseTestClient();
  const values = Object.fromEntries(
    Object.entries(valuesBySlug).map(([fieldSlug, value]) => [
      entity.fields[fieldSlug].key,
      value,
    ]),
  );
  const relations = Object.entries(relationsBySlug).map(
    ([fieldSlug, targetRecordId]) => {
      const field = entity.fields[fieldSlug];

      if (!field.relatedEntityTypeId) {
        throw new Error(`${field.name} is not a relation field.`);
      }

      return {
        field_definition_id: field.id,
        target_entity_type_id: field.relatedEntityTypeId,
        target_record_id: targetRecordId,
      };
    },
  );

  // Deliberately not retried: this RPC generates its own record id
  // server-side with no client-supplied dedup key, unlike the entity_types/
  // field_definitions inserts above (which use a client-generated UUID and
  // would fail loudly on a duplicate-key retry instead of silently
  // double-creating). Retrying a create whose response was merely lost --
  // rather than never reaching the server -- would risk a genuine duplicate
  // record, which is worse than the original transient failure.
  const { data, error } = await supabase.rpc("create_entity_record_with_relations", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: entity.id,
    p_values: values,
    p_relations: relations,
  });
  if (error) {
    throw new Error(`create E2E record for ${entity.name}: ${error.message}`);
  }

  return String(data);
}

export async function createWorkflowFixture(run: TestRun): Promise<WorkflowFixture> {
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Client", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "revenue", name: "Revenue", type: "number" },
    { slug: "tier", name: "Tier", type: "text" },
    { slug: "active", name: "Active", type: "boolean" },
  ]);
  const deliverable = await createEntity(supabase, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      required: true,
      relatedEntityTypeId: client.id,
    },
    { slug: "status", name: "Status", type: "text" },
  ]);
  const task = await createEntity(supabase, run, "Task", [
    { slug: "title", name: "Title", type: "text", required: true },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
    { slug: "status", name: "Status", type: "text" },
  ]);
  const clientRecordId = await createEntityRecord({
    entity: client,
    valuesBySlug: {
      name: `${run.label} Acme`,
      tier: "Gold",
      active: true,
    },
  });

  return {
    client,
    deliverable,
    task,
    clientRecordId,
  };
}

export async function createRecordUpdatedFixture(
  run: TestRun,
): Promise<RecordUpdatedFixture> {
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const ticket = await createEntity(supabase, run, "Ticket", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
    { slug: "notes", name: "Notes", type: "text" },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
  ]);
  const activity = await createEntity(supabase, run, "Activity", [
    { slug: "summary", name: "Summary", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
  ]);
  const firstClientRecordId = await createEntityRecord({
    entity: client,
    valuesBySlug: {
      name: `${run.label} Alpha Client`,
    },
  });
  const secondClientRecordId = await createEntityRecord({
    entity: client,
    valuesBySlug: {
      name: `${run.label} Beta Client`,
    },
  });

  return {
    client,
    ticket,
    activity,
    firstClientRecordId,
    secondClientRecordId,
  };
}

export async function createRelatedRecordWorkflowFixture(
  run: TestRun,
): Promise<RelatedRecordWorkflowFixture> {
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Client", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "last_status", name: "Last Deliverable Status", type: "text" },
    { slug: "notes", name: "Notes", type: "text" },
  ]);
  const deliverable = await createEntity(supabase, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
  ]);
  const firstClientRecordId = await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} Acme`, notes: "Original" },
  });
  const secondClientRecordId = await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} Contoso` },
  });

  return { client, deliverable, firstClientRecordId, secondClientRecordId };
}

export async function archiveTestField(field: TestField) {
  const supabase = createSupabaseTestClient();

  await throwOnError(
    () =>
      supabase
        .from("field_definitions")
        .update({ archived_at: new Date().toISOString() })
        .eq("workspace_id", DEMO_WORKSPACE_ID)
        .eq("id", field.id),
    `archive E2E field ${field.name}`,
  );
}

export async function listUncleanedE2eData(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const [workflows, entities] = await Promise.all([
    throwOnError(
      () =>
        supabase
          .from("workflows")
          .select("name")
          .eq("workspace_id", DEMO_WORKSPACE_ID)
          .ilike("name", `${run.label}%`),
      "list uncleaned E2E workflows",
    ),
    throwOnError(
      () =>
        supabase
          .from("entity_types")
          .select("name")
          .eq("workspace_id", DEMO_WORKSPACE_ID)
          .ilike("name", `${run.label}%`),
      "list uncleaned E2E entities",
    ),
  ]);

  return [
    ...(workflows ?? []).map((workflow) => `workflow:${workflow.name}`),
    ...(entities ?? []).map((entity) => `entity:${entity.name}`),
  ];
}
