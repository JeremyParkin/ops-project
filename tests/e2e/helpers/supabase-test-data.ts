import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { requireE2eEnv } from "./env";

export const DEMO_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const E2E_NAME_PREFIX = "E2E";

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

export function createSupabaseTestClient() {
  const { supabaseUrl, supabaseSecretKey } = requireE2eEnv();

  return createClient(supabaseUrl, supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
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
  result: { data: T; error: { message: string } | null },
  action: string,
) {
  if (result.error) {
    throw new Error(`${action}: ${result.error.message}`);
  }

  return result.data;
}

export async function cleanupStaleE2eData() {
  const supabase = createSupabaseTestClient();

  // The current prototype uses the development Supabase project, so every E2E
  // artifact is owned by the reserved "E2E " name prefix and can be reset here.
  // A separate Supabase test project or local Supabase should replace this
  // before running these tests in CI.
  await throwOnError(
    await supabase
      .from("workflows")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .ilike("name", `${E2E_NAME_PREFIX} %`),
    "clean up existing E2E workflows",
  );
  const staleEntities = await throwOnError(
    await supabase
      .from("entity_types")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .ilike("name", `${E2E_NAME_PREFIX} %`),
    "find existing E2E entities",
  );

  await cleanupEntitiesById(supabase, (staleEntities ?? []).map((entity) => entity.id));
}

export async function cleanupE2eRun(run: TestRun) {
  const supabase = createSupabaseTestClient();

  await throwOnError(
    await supabase
      .from("workflows")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .ilike("name", `${run.label}%`),
    "clean up E2E workflows",
  );
  const entities = await throwOnError(
    await supabase
      .from("entity_types")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .ilike("name", `${run.label}%`),
    "find E2E entities",
  );

  await cleanupEntitiesById(supabase, (entities ?? []).map((entity) => entity.id));
}

async function cleanupEntitiesById(supabase: SupabaseClient, entityTypeIds: string[]) {
  if (entityTypeIds.length === 0) {
    return;
  }

  await throwOnError(
    await supabase
      .from("entity_record_relation_values")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .in("source_entity_type_id", entityTypeIds),
    "clean up E2E source relation rows",
  );
  await throwOnError(
    await supabase
      .from("entity_record_relation_values")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .in("target_entity_type_id", entityTypeIds),
    "clean up E2E target relation rows",
  );
  await throwOnError(
    await supabase
      .from("entity_types")
      .update({ display_field_definition_id: null })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .in("id", entityTypeIds),
    "clear E2E display field references",
  );
  await throwOnError(
    await supabase
      .from("entity_views")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .in("entity_type_id", entityTypeIds),
    "clean up E2E saved views",
  );
  await throwOnError(
    await supabase
      .from("field_definitions")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .in("entity_type_id", entityTypeIds),
    "clean up E2E field definitions",
  );
  // process_runs.origin_record_id and process_templates.applies_to_entity_type_id
  // both carry an ON DELETE RESTRICT foreign key back to entity_types/entity_records
  // (see migration 0027), so both must be cleared before entity_records/entity_types
  // can be deleted below. process_step_runs and process_nodes/process_edges cascade
  // from process_runs/process_templates respectively, so deleting those two is enough.
  await throwOnError(
    await supabase
      .from("process_runs")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .in("origin_entity_type_id", entityTypeIds),
    "clean up E2E process runs",
  );
  await throwOnError(
    await supabase
      .from("process_templates")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .in("applies_to_entity_type_id", entityTypeIds),
    "clean up E2E process templates",
  );
  await throwOnError(
    await supabase
      .from("entity_records")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .in("entity_type_id", entityTypeIds),
    "clean up E2E records",
  );
  await throwOnError(
    await supabase
      .from("entity_types")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .in("id", entityTypeIds),
    "clean up E2E entities",
  );
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
    await supabase.from("entity_types").insert({
      id: entity.id,
      workspace_id: DEMO_WORKSPACE_ID,
      name: entity.name,
      slug: entity.slug,
      description: "Created by automated E2E tests.",
    }),
    `create E2E entity ${entity.name}`,
  );

  await throwOnError(
    await supabase.from("field_definitions").insert(
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

  const data = await throwOnError(
    await supabase.rpc("create_entity_record_with_relations", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_entity_type_id: entity.id,
      p_values: values,
      p_relations: relations,
    }),
    `create E2E record for ${entity.name}`,
  );

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
    await supabase
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
      await supabase
        .from("workflows")
        .select("name")
        .eq("workspace_id", DEMO_WORKSPACE_ID)
        .ilike("name", `${run.label}%`),
      "list uncleaned E2E workflows",
    ),
    throwOnError(
      await supabase
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
