import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestEntity,
  type TestRun,
} from "./helpers/supabase-test-data";
import {
  addRecordSection,
  fillRecordField,
  gotoEntity,
  rowForText,
  selectReactOption,
  submitAddRecord,
} from "./helpers/ui";

test.describe.configure({ mode: "serial" });

const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";

const runs: TestRun[] = [];
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];

type PreferenceRow = {
  user_id: string;
  theme: "system" | "light" | "dark";
  timezone: string | null;
  notify_comment_mentions: boolean;
  notify_input_request_status_updates: boolean;
  display_name: string | null;
};

test.beforeAll(async () => {
  await cleanupStaleE2eData();
});

test.afterAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  const supabase = createSupabaseTestClient();
  for (const run of runs) {
    await cleanupE2eRun(run);
  }
  for (const userId of createdUserIds) {
    await supabase.auth.admin.deleteUser(userId);
  }
  if (createdRoleIds.length > 0) {
    await supabase
      .from("workspace_roles")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .in("id", createdRoleIds);
  }
});

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);

  return run;
}

async function createView({
  entity,
  name,
  filters = [],
  sorts = [],
  columnFieldDefinitionIds,
  presentationMode = "table",
  presentationConfig = {},
  isDefault = false,
}: {
  entity: TestEntity;
  name: string;
  filters?: unknown[];
  sorts?: unknown[];
  columnFieldDefinitionIds?: string[];
  presentationMode?: "table" | "board" | "calendar";
  presentationConfig?: Record<string, string>;
  isDefault?: boolean;
}) {
  const supabase = createSupabaseTestClient();
  const { data: existingViews, error: viewError } = await supabase
    .from("entity_views")
    .select("position")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id);
  expect(viewError).toBeNull();

  const position =
    (existingViews ?? []).reduce(
      (max, view) => Math.max(max, Number(view.position)),
      0,
    ) + 1;
  const result = await supabase
    .from("entity_views")
    .insert({
      workspace_id: DEMO_WORKSPACE_ID,
      entity_type_id: entity.id,
      name,
      position,
      is_default: isDefault,
      filters,
      sorts,
      column_field_definition_ids:
        columnFieldDefinitionIds ??
        Object.values(entity.fields)
          .sort((left, right) => left.position - right.position)
          .map((field) => field.id),
      presentation_mode: presentationMode,
      presentation_config: presentationConfig,
    })
    .select("id")
    .single<{ id: string }>();

  expect(result.error).toBeNull();

  return String(result.data?.id);
}

async function addChoiceField(entity: TestEntity, slug: string, name: string, required = false) {
  const supabase = createSupabaseTestClient();
  const field = {
    id: randomUUID(),
    key: `fld_e2e_${randomUUID().replace(/-/g, "_")}_${slug}`,
    position: Object.keys(entity.fields).length + 1,
    slug,
    name,
    type: "choice",
    required,
  };
  const { error } = await supabase.from("field_definitions").insert({
    id: field.id,
    workspace_id: DEMO_WORKSPACE_ID,
    entity_type_id: entity.id,
    key: field.key,
    name: field.name,
    slug: field.slug,
    type: field.type,
    related_entity_type_id: null,
    required,
    position: field.position,
  });
  expect(error).toBeNull();

  entity.fields[slug] = field as TestEntity["fields"][string];
  return field;
}

async function addChoiceOption({
  fieldId,
  label,
  color = "gray",
  position,
  archived = false,
}: {
  fieldId: string;
  label: string;
  color?: string;
  position: number;
  archived?: boolean;
}) {
  const supabase = createSupabaseTestClient();
  const optionId = randomUUID();
  const { error } = await supabase.from("field_choice_options").insert({
    id: optionId,
    workspace_id: DEMO_WORKSPACE_ID,
    field_definition_id: fieldId,
    label,
    color,
    position,
    archived_at: archived ? new Date().toISOString() : null,
  });
  expect(error).toBeNull();

  return optionId;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

async function createReadOnlyUser() {
  const supabase = createSupabaseTestClient();
  const password = `Views-${randomUUID()}!`;
  const email = `e2e-views-readonly-${randomUUID()}@example.test`;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  expect(data.user).toBeTruthy();
  createdUserIds.push(data.user!.id);

  const roleId = randomUUID();
  const role = await supabase.from("workspace_roles").insert({
    id: roleId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `E2E Views read-only ${roleId.slice(0, 8)}`,
  });
  expect(role.error).toBeNull();
  createdRoleIds.push(roleId);

  const membership = await supabase.from("workspace_memberships").insert({
    workspace_id: DEMO_WORKSPACE_ID,
    user_id: data.user!.id,
    role_id: roleId,
  });
  expect(membership.error).toBeNull();

  return { email, password };
}

function parseRgb(value: string) {
  const hex = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex) {
    return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)] as const;
  }

  const oklch = value.match(/oklch\(([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/);
  if (oklch) {
    const lightness = oklch[1].endsWith("%")
      ? Number(oklch[1].slice(0, -1)) / 100
      : Number(oklch[1]);
    const chroma = Number(oklch[2]);
    const hueRadians = (Number(oklch[3]) * Math.PI) / 180;
    const a = chroma * Math.cos(hueRadians);
    const b = chroma * Math.sin(hueRadians);
    const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
    const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
    const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
    const l = lPrime ** 3;
    const m = mPrime ** 3;
    const s = sPrime ** 3;
    const linearRgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    const toSrgb = (channel: number) => {
      const clamped = Math.min(1, Math.max(0, channel));
      const encoded = clamped <= 0.0031308
        ? 12.92 * clamped
        : 1.055 * clamped ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255);
    };

    return linearRgb.map(toSrgb) as [number, number, number];
  }

  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) {
    throw new Error(`Unable to parse computed rgb color: ${value}`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function channelToLinear(value: number) {
  const channel = value / 255;
  return channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: readonly [number, number, number]) {
  return (
    0.2126 * channelToLinear(rgb[0]) +
    0.7152 * channelToLinear(rgb[1]) +
    0.0722 * channelToLinear(rgb[2])
  );
}

function contrastRatio(color: string, backgroundColor: string) {
  const foreground = relativeLuminance(parseRgb(color));
  const background = relativeLuminance(parseRgb(backgroundColor));
  const lighter = Math.max(foreground, background);
  const darker = Math.min(foreground, background);

  return (lighter + 0.05) / (darker + 0.05);
}

async function computedTextContrast(locator: ReturnType<Page["locator"]>) {
  const styles = await locator.first().evaluate((element) => {
    function normalizeColor(value: string) {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) {
        return value;
      }
      context.fillStyle = value;

      return context.fillStyle;
    }

    let node: Element | null = element;
    let backgroundColor = "rgba(0, 0, 0, 0)";

    while (node) {
      const resolved = getComputedStyle(node).backgroundColor;

      if (resolved && resolved !== "rgba(0, 0, 0, 0)" && resolved !== "transparent") {
        backgroundColor = resolved;
        break;
      }

      node = node.parentElement;
    }

    const computed = getComputedStyle(element);
    return {
      color: normalizeColor(computed.color),
      backgroundColor: normalizeColor(backgroundColor),
      borderColor: computed.borderColor,
      outlineStyle: computed.outlineStyle,
      outlineWidth: computed.outlineWidth,
    };
  });

  return {
    ...styles,
    ratio: contrastRatio(styles.color, styles.backgroundColor),
  };
}

async function getE2eRunnerPreferences() {
  const supabase = createSupabaseTestClient();
  const { data: users, error: userError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  expect(userError).toBeNull();
  const runner = users.users.find((user) => user.email === E2E_RUNNER_EMAIL);
  expect(runner).toBeTruthy();

  const preferences = await supabase
    .from("user_preferences")
    .select("user_id, theme, timezone, notify_comment_mentions, notify_input_request_status_updates, display_name")
    .eq("user_id", runner!.id)
    .maybeSingle<PreferenceRow>();
  expect(preferences.error).toBeNull();

  return { runnerUserId: runner!.id, preferences: preferences.data ?? null };
}

async function setE2eRunnerTheme(userId: string, theme: PreferenceRow["theme"]) {
  const supabase = createSupabaseTestClient();
  const result = await supabase.from("user_preferences").upsert({ user_id: userId, theme });
  expect(result.error).toBeNull();
}

async function restoreE2eRunnerPreferences(
  userId: string,
  preferences: PreferenceRow | null,
) {
  const supabase = createSupabaseTestClient();
  if (preferences) {
    const result = await supabase.from("user_preferences").upsert(preferences);
    expect(result.error).toBeNull();
    return;
  }

  const result = await supabase.from("user_preferences").delete().eq("user_id", userId);
  expect(result.error).toBeNull();
}

function lane(page: Page, label: string) {
  return page
    .getByRole("region", { name: /board grouped by/i })
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: label }) });
}

function cardInLane(page: Page, laneLabel: string, cardLabel: string) {
  return lane(page, laneLabel).locator("article").filter({
    has: page.getByRole("link", { name: cardLabel, exact: true }),
  });
}

async function moveCard({
  page,
  from,
  card,
  to,
  keyboard = false,
}: {
  page: Page;
  from: string;
  card: string;
  to: string;
  keyboard?: boolean;
}) {
  const boardCard = cardInLane(page, from, card);
  await boardCard.getByLabel("Move to").selectOption({ label: to });
  const button = boardCard.getByRole("button", { name: "Move" });
  if (keyboard) {
    await button.focus();
    await page.keyboard.press("Enter");
  } else {
    await button.click();
  }
}

async function createPresentationViewsScenario(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const work = await createEntity(supabase, run, "Presentation Work", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "due", name: "Due", type: "date" },
  ]);
  const stage = await addChoiceField(work, "stage", "Stage");

  await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} Presentation Record`,
      due: "2026-08-20",
    },
  });

  return { work, stage };
}

async function createBoardScenario(run: TestRun, required = false) {
  const supabase = createSupabaseTestClient();
  const work = await createEntity(supabase, run, required ? "Required Board Work" : "Board Work", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "notes", name: "Notes", type: "text" },
  ]);
  const stage = await addChoiceField(work, "stage", "Stage", required);
  const todoId = await addChoiceOption({
    fieldId: stage.id,
    label: "Todo",
    color: "gray",
    position: 1,
  });
  const doingId = await addChoiceOption({
    fieldId: stage.id,
    label: "Doing",
    color: "blue",
    position: 2,
  });
  const doneId = await addChoiceOption({
    fieldId: stage.id,
    label: "Done",
    color: "emerald",
    position: 3,
  });
  const parkedId = await addChoiceOption({
    fieldId: stage.id,
    label: "Parked",
    color: "amber",
    position: 4,
  });
  await addChoiceOption({
    fieldId: stage.id,
    label: "Empty Archived",
    color: "red",
    position: 5,
    archived: true,
  });

  const alphaId = await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} Alpha`,
      notes: "",
      stage: todoId,
    },
  });
  const aardvarkId = await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} Aardvark`,
      notes: "",
      stage: todoId,
    },
  });
  const betaId = await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} Beta`,
      notes: "",
      stage: doingId,
    },
  });
  const gammaId = await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} Gamma`,
      notes: "",
      stage: required ? doneId : null,
    },
  });
  const archivedValueId = await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} Archived Value`,
      notes: "",
      stage: parkedId,
    },
  });
  const { error: archiveParkedError } = await supabase.rpc("archive_field_choice_option", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_field_definition_id: stage.id,
    p_option_id: parkedId,
  });
  if (archiveParkedError) {
    throw new Error(`archive board scenario option: ${archiveParkedError.message}`);
  }

  const boardViewId = await createView({
    entity: work,
    name: `${run.label} Board`,
    presentationMode: "board",
    presentationConfig: { choiceFieldDefinitionId: stage.id },
    columnFieldDefinitionIds: [work.fields.title.id, stage.id],
  });

  return {
    work,
    stage,
    options: { todoId, doingId, doneId, parkedId },
    records: { alphaId, aardvarkId, betaId, gammaId, archivedValueId },
    boardViewId,
  };
}

async function createViewsScenario(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "View Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const work = await createEntity(supabase, run, "View Work", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
    { slug: "priority", name: "Priority", type: "number" },
    { slug: "due", name: "Due", type: "date" },
    { slug: "done", name: "Done", type: "boolean" },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
  ]);
  const acmeId = await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} Acme` },
  });
  const betaId = await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} Beta` },
  });

  await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} QA Prep`,
      status: "Needs QA",
      priority: 3,
      due: "2026-08-20",
      done: false,
    },
    relationsBySlug: { client: acmeId },
  });
  await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} Launch`,
      status: "Completed",
      priority: 1,
      due: "2026-08-18",
      done: true,
    },
    relationsBySlug: { client: betaId },
  });
  await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} QA Fix`,
      status: "Needs QA",
      priority: 2,
      due: "2026-08-22",
      done: false,
    },
    relationsBySlug: { client: acmeId },
  });

  return { client, work, acmeId, betaId };
}

test("existing entity with no saved views still shows all records", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);

  await gotoEntity(page, work);
  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Launch`)).toBeVisible();
  await expect(rowForText(page, `${run.label} QA Fix`)).toBeVisible();
});

test("creates a saved text-filtered view through the UI", async ({ page }) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);

  await gotoEntity(page, work);
  await page.getByText("Manage views", { exact: true }).click();
  await page.getByLabel("View Name").fill(`${run.label} Needs QA`);
  await page.getByRole("button", { name: "Add Filter", exact: true }).click();
  await selectReactOption(page.locator('select[name="filterField:0"]'), {
    label: "Status (text)",
  });
  await selectReactOption(page.locator('select[name="filterOperator:0"]'), {
    value: "contains",
  });
  await page.locator('input[name="filterValue:0"]').fill("qa");
  await page.getByRole("button", { name: "Create View" }).click();
  await expect(page.getByText("View created.")).toBeVisible();

  await page.getByRole("link", { name: `${run.label} Needs QA` }).click();
  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(rowForText(page, `${run.label} QA Fix`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Launch`)).toHaveCount(0);
});

test("typed filters and AND semantics evaluate deterministically", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Typed`,
    filters: [
      {
        fieldDefinitionId: work.fields.status.id,
        operator: "equals",
        value: "Needs QA",
      },
      {
        fieldDefinitionId: work.fields.priority.id,
        operator: "greater_than_or_equal",
        value: 2,
      },
      {
        fieldDefinitionId: work.fields.due.id,
        operator: "after",
        value: "2026-08-19",
      },
      {
        fieldDefinitionId: work.fields.done.id,
        operator: "equals",
        value: false,
      },
    ],
  });

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(rowForText(page, `${run.label} QA Fix`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Launch`)).toHaveCount(0);
});

test("relation filters use human-readable labels", async ({ page }) => {
  const run = createScenarioRun();
  const { work, acmeId } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Acme Work`,
    filters: [
      {
        fieldDefinitionId: work.fields.client.id,
        operator: "equals",
        value: acmeId,
      },
    ],
  });

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(rowForText(page, `${run.label} QA Prep`)).toContainText(
    `${run.label} Acme`,
  );
  await expect(rowForText(page, `${run.label} QA Fix`)).toContainText(
    `${run.label} Acme`,
  );
  await expect(rowForText(page, `${run.label} Launch`)).toHaveCount(0);
});

test("sorting, column visibility, and column order persist", async ({ page }) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Ordered`,
    sorts: [
      {
        fieldDefinitionId: work.fields.priority.id,
        direction: "desc",
      },
    ],
    columnFieldDefinitionIds: [
      work.fields.priority.id,
      work.fields.title.id,
      work.fields.status.id,
    ],
  });

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  const headers = page.getByRole("table").getByRole("columnheader");
  // Sortable headers (all but the relation column) render as click-to-sort
  // links, which also carry a visually-hidden sort-state description -- so
  // this asserts the visible column order via containment, not exact text.
  // Index 0 is the Phase 9.5 bulk-selection header checkbox column, which
  // always leads and carries no text -- field columns start at index 1.
  await expect(headers.nth(1)).toContainText("Priority");
  await expect(headers.nth(2)).toContainText("Title");
  await expect(headers.nth(3)).toContainText("Status");
  await expect(headers.filter({ hasText: "Due" })).toHaveCount(0);

  const rows = page.getByRole("table").getByRole("row");
  await expect(rows.nth(1)).toContainText(`${run.label} QA Prep`);
  await expect(rows.nth(2)).toContainText(`${run.label} QA Fix`);
  await expect(rows.nth(3)).toContainText(`${run.label} Launch`);

  await page.reload();
  await expect(headers.nth(1)).toContainText("Priority");
});

test("default view can be used and cleared back to All Records", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);
  await createView({
    entity: work,
    name: `${run.label} Default QA`,
    isDefault: true,
    filters: [
      {
        fieldDefinitionId: work.fields.status.id,
        operator: "equals",
        value: "Needs QA",
      },
    ],
  });

  await page.goto(`/entities/${work.id}`);
  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Launch`)).toHaveCount(0);

  await page.getByRole("link", { name: `All ${work.name}` }).click();
  await expect(rowForText(page, `${run.label} Launch`)).toBeVisible();
});

test("editing a record can move it into a filtered view", async ({ page }) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Completed`,
    filters: [
      {
        fieldDefinitionId: work.fields.status.id,
        operator: "equals",
        value: "Completed",
      },
    ],
  });

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(rowForText(page, `${run.label} Launch`)).toBeVisible();
  await expect(rowForText(page, `${run.label} New Done`)).toHaveCount(0);

  await gotoEntity(page, work);
  const form = addRecordSection(page, work);
  await fillRecordField(form, work.fields.title, `${run.label} New Done`);
  await fillRecordField(form, work.fields.status, "Completed");
  await submitAddRecord(page, work);
  await expect(page.getByText(`${work.name} created.`)).toBeVisible();

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(rowForText(page, `${run.label} New Done`)).toBeVisible();
});

test("archived filter references fail closed with repair warning", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { work } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Stale`,
    filters: [
      {
        fieldDefinitionId: work.fields.status.id,
        operator: "equals",
        value: "Needs QA",
      },
    ],
  });
  const archiveResult = await supabase
    .from("field_definitions")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", work.id)
    .eq("id", work.fields.status.id);
  expect(archiveResult.error).toBeNull();

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(page.getByText("View needs repair.")).toBeVisible();
  await expect(
    page.getByText("This view cannot be evaluated correctly."),
  ).toBeVisible();
  await expect(rowForText(page, `${run.label} QA Prep`)).toHaveCount(0);
  await expect(page.getByRole("link", { name: `All ${work.name}` })).toBeVisible();
});

test("quick filter bar narrows records live and can be saved as a new view", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);

  await gotoEntity(page, work);
  await expect(rowForText(page, `${run.label} Launch`)).toBeVisible();

  await page.getByRole("button", { name: "+ Add filter" }).click();
  await selectReactOption(page.getByLabel("Quick filter field"), {
    label: "Status (text)",
  });
  await selectReactOption(page.getByLabel("Quick filter operator"), {
    value: "contains",
  });
  await page.getByLabel("Quick filter value").fill("qa");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(rowForText(page, `${run.label} QA Fix`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Launch`)).toHaveCount(0);
  await expect(page.getByText('Status contains "qa"')).toBeVisible();
  await expect(page.getByText("Unsaved changes to All Records")).toBeVisible();

  await page.getByRole("button", { name: "Save as View" }).click();
  await page.getByLabel("View Name").fill(`${run.label} Quick Saved`);
  await page.getByRole("button", { name: "Create View" }).click();
  await expect(page.getByText("View created.")).toBeVisible();

  await page.getByRole("link", { name: `${run.label} Quick Saved` }).click();
  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Launch`)).toHaveCount(0);
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);

  await page.reload();
  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(page.getByText('Status contains "qa"')).toBeVisible();
});

test("quick view controls show a scope heading and label matching the selected view", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);
  await createView({
    entity: work,
    name: `${run.label} Scope Label View`,
  });

  await gotoEntity(page, work);
  const quickBar = page.getByTestId("entity-view-quickbar");
  await expect(quickBar.getByRole("heading", { name: "View controls" })).toBeVisible();
  await expect(quickBar.getByText("All Records", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: `${run.label} Scope Label View` }).click();
  await expect(
    quickBar.getByText(`View: ${run.label} Scope Label View`, { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "+ Add filter" }).click();
  await selectReactOption(page.getByLabel("Quick filter field"), {
    label: "Status (text)",
  });
  await selectReactOption(page.getByLabel("Quick filter operator"), {
    value: "contains",
  });
  await page.getByLabel("Quick filter value").fill("qa");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(page.getByText('Status contains "qa"')).toBeVisible();
  await expect(
    page.getByText(`Unsaved changes to ${run.label} Scope Label View`),
  ).toBeVisible();
});

test("clicking a column header cycles sort ascending, descending, then back to unsorted", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);

  await gotoEntity(page, work);
  const rows = page.getByRole("table").getByRole("row");

  await page.getByRole("link", { name: "Priority" }).click();
  await expect(rows.nth(1)).toContainText(`${run.label} Launch`);
  await expect(rows.nth(2)).toContainText(`${run.label} QA Fix`);
  await expect(rows.nth(3)).toContainText(`${run.label} QA Prep`);
  await expect(page.getByText("Sort: Priority")).toBeVisible();

  await page.getByRole("link", { name: "Priority" }).click();
  await expect(rows.nth(1)).toContainText(`${run.label} QA Prep`);
  await expect(rows.nth(2)).toContainText(`${run.label} QA Fix`);
  await expect(rows.nth(3)).toContainText(`${run.label} Launch`);

  await page.getByRole("link", { name: "Priority" }).click();
  await expect(page.getByText("Sort: Priority")).toHaveCount(0);
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
});

test("quick columns control shows/hides a column without a saved view", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);

  await gotoEntity(page, work);
  const headers = page.getByRole("table").getByRole("columnheader");
  await expect(headers.filter({ hasText: "Due" })).toHaveCount(1);

  const quickBar = page.getByTestId("entity-view-quickbar");
  await quickBar.getByRole("button", { name: "Columns", exact: true }).click();
  await quickBar.getByLabel("Due (date)").uncheck();
  await quickBar.getByRole("button", { name: "Apply columns" }).click();

  await expect(headers.filter({ hasText: "Due" })).toHaveCount(0);
  await expect(page.getByText("Unsaved changes to All Records")).toBeVisible();
});

test("quick bar can update the currently selected saved view", async ({ page }) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Quick Update Target`,
    filters: [
      {
        fieldDefinitionId: work.fields.status.id,
        operator: "equals",
        value: "Needs QA",
      },
    ],
  });

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(rowForText(page, `${run.label} QA Fix`)).toBeVisible();

  await page.getByRole("button", { name: "+ Add sort" }).click();
  await selectReactOption(page.getByLabel("Quick sort field"), {
    label: "Priority (number)",
  });
  await selectReactOption(page.getByLabel("Quick sort direction"), {
    value: "desc",
  });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(`Unsaved changes to ${run.label} Quick Update Target`)).toBeVisible();

  await page.getByRole("button", { name: "Update View" }).click();
  await page.getByRole("button", { name: "Save View" }).click();
  await expect(page.getByText("View updated.")).toBeVisible();

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  const rows = page.getByRole("table").getByRole("row");
  await expect(rows.nth(1)).toContainText(`${run.label} QA Prep`);
  await expect(rows.nth(2)).toContainText(`${run.label} QA Fix`);
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
});

test("presentation modes can be saved, reloaded, and shown as placeholders", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work, stage } = await createPresentationViewsScenario(run);

  await gotoEntity(page, work);
  await page.getByText("Manage views", { exact: true }).click();
  await page.locator("#create-view-name").fill(`${run.label} Board`);
  await page.locator("#create-presentation-mode").selectOption("board");
  await page.locator("#create-board-choice-field").selectOption(stage.id);
  await page.getByRole("button", { name: "Create View" }).click();
  await expect(page.getByText("View created.")).toBeVisible();

  await page.getByRole("link", { name: `${run.label} Board` }).click();
  await expect(page.getByRole("region", { name: /board grouped by Stage/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Board view configured" })).toHaveCount(0);
  await expect(page.getByTestId("entity-view-quickbar").getByRole("button", { name: "Columns" })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("region", { name: /board grouped by Stage/i })).toBeVisible();
  await page.getByText("Manage views", { exact: true }).click();
  await expect(page.locator("#edit-presentation-mode")).toHaveValue("board");
  await expect(page.locator("#edit-board-choice-field")).toHaveValue(stage.id);

  await page.goto(`/entities/${work.id}?newView=true`);
  await page.locator("#create-view-name").fill(`${run.label} Calendar`);
  await page.locator("#create-presentation-mode").selectOption("calendar");
  await page.locator("#create-calendar-date-field").selectOption(work.fields.due.id);
  await page.getByRole("button", { name: "Create View" }).click();
  await expect(page.getByText("View created.")).toBeVisible();

  await page.getByRole("link", { name: `${run.label} Calendar` }).click();
  await expect(page.getByRole("heading", { name: "Calendar view configured" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Calendar view configured" })).toBeVisible();
});

test("stale presentation config shows repair before placeholder", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { work, stage } = await createPresentationViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Stale Board`,
    presentationMode: "board",
    presentationConfig: { choiceFieldDefinitionId: stage.id },
  });

  const archiveResult = await supabase
    .from("field_definitions")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", work.id)
    .eq("id", stage.id);
  expect(archiveResult.error).toBeNull();

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(page.getByRole("heading", { name: "View needs repair." })).toBeVisible();
  await expect(page.getByText("invalid presentation configuration")).toBeVisible();
  await expect(page.getByRole("region", { name: /board grouped by Stage/i })).toHaveCount(0);
});

test("pending quick edits preserve configured presentation", async ({ page }) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { work, stage } = await createPresentationViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Board Pending`,
    columnFieldDefinitionIds: [work.fields.title.id, stage.id],
    presentationMode: "board",
    presentationConfig: { choiceFieldDefinitionId: stage.id },
  });

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(page.getByRole("region", { name: /board grouped by Stage/i })).toBeVisible();
  await expect(page.getByTestId("entity-view-quickbar").getByRole("button", { name: "Columns" })).toHaveCount(0);

  await page.getByRole("button", { name: "+ Add sort" }).click();
  await selectReactOption(page.getByLabel("Quick sort field"), {
    label: "Title (text)",
  });
  await selectReactOption(page.getByLabel("Quick sort direction"), {
    value: "asc",
  });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(`Unsaved changes to ${run.label} Board Pending`)).toBeVisible();

  await page.getByRole("button", { name: "Update View" }).click();
  await page.getByRole("button", { name: "Save View" }).click();
  await expect(page.getByText("View updated.")).toBeVisible();
  await expect(page.getByRole("region", { name: /board grouped by Stage/i })).toBeVisible();

  const { data, error } = await supabase
    .from("entity_views")
    .select("presentation_mode,presentation_config,sorts")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", viewId)
    .single();
  expect(error).toBeNull();
  expect(data?.presentation_mode).toBe("board");
  expect(data?.presentation_config).toEqual({ choiceFieldDefinitionId: stage.id });
  expect(data?.sorts).toEqual([{ fieldDefinitionId: work.fields.title.id, direction: "asc" }]);
});

test("board renders active, unset, archived lanes and respects view filters and sorts", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work, stage, options } = await createBoardScenario(run);
  const filteredViewId = await createView({
    entity: work,
    name: `${run.label} Todo Board`,
    filters: [
      {
        fieldDefinitionId: stage.id,
        operator: "equals",
        value: options.todoId,
      },
    ],
    sorts: [
      {
        fieldDefinitionId: work.fields.title.id,
        direction: "asc",
      },
    ],
    presentationMode: "board",
    presentationConfig: { choiceFieldDefinitionId: stage.id },
  });

  await page.goto(`/entities/${work.id}?view=${filteredViewId}`);
  await expect(page.getByRole("region", { name: /board grouped by Stage/i })).toBeVisible();
  await expect(lane(page, "Todo").getByText("2 records")).toBeVisible();
  await expect(lane(page, "Doing").getByText("0 records")).toBeVisible();
  await expect(lane(page, "Done").getByText("0 records")).toBeVisible();
  await expect(lane(page, "Unset").getByText("0 records")).toBeVisible();
  await expect(lane(page, "Parked")).toHaveCount(0);

  const todoCards = lane(page, "Todo").locator("article");
  await expect(todoCards.nth(0)).toContainText(`${run.label} Aardvark`);
  await expect(todoCards.nth(1)).toContainText(`${run.label} Alpha`);

  const emptyParams = new URLSearchParams({
    view: filteredViewId,
    "filterField:0": work.fields.title.id,
    "filterOperator:0": "contains",
    "filterValue:0": "no-match",
  });
  emptyParams.append("columnFieldDefinitionId", work.fields.title.id);
  emptyParams.append("columnFieldDefinitionId", stage.id);
  await page.goto(`/entities/${work.id}?${emptyParams.toString()}`);
  await expect(page.getByRole("heading", { name: "No records match your current filters." })).toBeVisible();
  await expect(lane(page, "Todo")).toBeVisible();

  const archivedBoardViewId = await createView({
    entity: work,
    name: `${run.label} Archived Board`,
    presentationMode: "board",
    presentationConfig: { choiceFieldDefinitionId: stage.id },
  });
  await page.goto(`/entities/${work.id}?view=${archivedBoardViewId}`);
  await expect(lane(page, "Parked").getByText("Archived option")).toBeVisible();
  await expect(cardInLane(page, "Parked", `${run.label} Archived Value`)).toBeVisible();
  await expect(lane(page, "Empty Archived")).toHaveCount(0);
});

test("board Move uses the canonical update path and preserves record_updated automation", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { work, stage, records, boardViewId } = await createBoardScenario(run);
  const workflowName = `${run.label} Board Move Automation`;
  const workflow = await supabase.from("workflows").insert({
    workspace_id: DEMO_WORKSPACE_ID,
    name: workflowName,
    enabled: true,
    trigger_type: "record_updated",
    trigger_entity_type_id: work.id,
    action_config: {
      triggerConfig: { watchedFieldDefinitionIds: [stage.id] },
      conditions: [],
    },
    actions: [
      {
        actionType: "update_record",
        fieldMappings: [
          {
            targetFieldDefinitionId: work.fields.notes.id,
            source: {
              type: "constant",
              value: "Moved by board automation",
            },
          },
        ],
      },
    ],
  });
  expect(workflow.error).toBeNull();

  await page.goto(`/entities/${work.id}?view=${boardViewId}`);
  await moveCard({
    page,
    from: "Todo",
    card: `${run.label} Alpha`,
    to: "Done",
  });
  await expect(cardInLane(page, "Done", `${run.label} Alpha`)).toBeVisible();

  const alpha = await supabase
    .from("entity_records")
    .select("values")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", work.id)
    .eq("id", records.alphaId)
    .single();
  expect(alpha.error).toBeNull();
  expect(alpha.data?.values?.[work.fields.notes.key]).toBe("Moved by board automation");

  await moveCard({
    page,
    from: "Doing",
    card: `${run.label} Beta`,
    to: "Unset",
    keyboard: true,
  });
  await expect(cardInLane(page, "Unset", `${run.label} Beta`)).toBeVisible();

  const archivedCard = cardInLane(page, "Parked", `${run.label} Archived Value`);
  await expect(archivedCard.getByLabel("Move to")).not.toContainText("Parked");
  await moveCard({
    page,
    from: "Parked",
    card: `${run.label} Archived Value`,
    to: "Todo",
  });
  await expect(cardInLane(page, "Todo", `${run.label} Archived Value`)).toBeVisible();
});

test("board hides Move for read-only users and failed moves stay local", async ({
  browser,
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { work, records, boardViewId } = await createBoardScenario(run);

  await page.goto(`/entities/${work.id}?view=${boardViewId}`);
  const alpha = cardInLane(page, "Todo", `${run.label} Alpha`);
  await expect(alpha).toBeVisible();
  const archived = await supabase
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", work.id)
    .eq("id", records.alphaId);
  expect(archived.error).toBeNull();

  await moveCard({
    page,
    from: "Todo",
    card: `${run.label} Alpha`,
    to: "Done",
  });
  await expect(alpha.getByRole("alert")).toContainText("Archived records are read-only.");
  await expect(cardInLane(page, "Todo", `${run.label} Alpha`)).toBeVisible();
  await expect(cardInLane(page, "Done", `${run.label} Alpha`)).toHaveCount(0);

  const readOnly = await createReadOnlyUser();
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const readOnlyPage = await context.newPage();
  try {
    await signIn(readOnlyPage, readOnly.email, readOnly.password);
    await readOnlyPage.goto(`/entities/${work.id}?view=${boardViewId}`);
    await expect(readOnlyPage.getByRole("region", { name: /board grouped by Stage/i })).toBeVisible();
    await expect(readOnlyPage.getByLabel("Move to")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("required Choice board omits Unset lane and destination", async ({ page }) => {
  const run = createScenarioRun();
  const { work, boardViewId } = await createBoardScenario(run, true);

  await page.goto(`/entities/${work.id}?view=${boardViewId}`);
  await expect(page.getByRole("region", { name: /board grouped by Stage/i })).toBeVisible();
  await expect(lane(page, "Unset")).toHaveCount(0);
  await expect(cardInLane(page, "Todo", `${run.label} Alpha`).getByLabel("Move to")).not.toContainText("Unset");
});

test("board Move controls stay readable in light, dark, and system themes", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { runnerUserId, preferences } = await getE2eRunnerPreferences();
  const { work, records, boardViewId } = await createBoardScenario(run);

  try {
    for (const mode of [
      { theme: "light" as const, colorScheme: "light" as const },
      { theme: "dark" as const, colorScheme: "light" as const },
      { theme: "system" as const, colorScheme: "light" as const },
      { theme: "system" as const, colorScheme: "dark" as const },
    ]) {
      await setE2eRunnerTheme(runnerUserId, mode.theme);
      await page.emulateMedia({ colorScheme: mode.colorScheme });
      await page.goto(`/entities/${work.id}?view=${boardViewId}`);
      await expect(page.getByRole("region", { name: /board grouped by Stage/i })).toBeVisible();

      const alpha = cardInLane(page, "Todo", `${run.label} Alpha`);
      const select = alpha.getByLabel("Move to");
      const button = alpha.getByRole("button", { name: "Move" });
      await expect(button).toBeDisabled();
      await expect((await computedTextContrast(button)).ratio).toBeGreaterThanOrEqual(4.5);
      await expect((await computedTextContrast(select)).ratio).toBeGreaterThanOrEqual(4.5);

      await select.focus();
      let focusStyles = await computedTextContrast(select);
      expect(focusStyles.outlineStyle).not.toBe("none");
      expect(parseFloat(focusStyles.outlineWidth)).toBeGreaterThan(0);

      await select.selectOption({ label: "Done" });
      await expect(button).toBeEnabled();
      await expect((await computedTextContrast(button)).ratio).toBeGreaterThanOrEqual(4.5);
      await button.focus();
      focusStyles = await computedTextContrast(button);
      expect(focusStyles.outlineStyle).not.toBe("none");
      expect(parseFloat(focusStyles.outlineWidth)).toBeGreaterThan(0);

      await expect((await computedTextContrast(lane(page, "Done").getByText("No records."))).ratio).toBeGreaterThanOrEqual(4.5);
      await expect((await computedTextContrast(lane(page, "Todo").locator("[title='Todo']"))).ratio).toBeGreaterThanOrEqual(4.5);
      await expect((await computedTextContrast(lane(page, "Doing").locator("[title='Doing']"))).ratio).toBeGreaterThanOrEqual(4.5);
      await expect((await computedTextContrast(lane(page, "Parked").locator("[title='Parked (Archived)']"))).ratio).toBeGreaterThanOrEqual(4.5);
    }

    await setE2eRunnerTheme(runnerUserId, "dark");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`/entities/${work.id}?view=${boardViewId}`);
    const archived = await supabase
      .from("entity_records")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("entity_type_id", work.id)
      .eq("id", records.alphaId);
    expect(archived.error).toBeNull();

    let delayedPost = false;
    await page.route("**/entities/**", async (route) => {
      if (route.request().method() === "POST" && !delayedPost) {
        delayedPost = true;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await route.continue();
    });

    const alpha = cardInLane(page, "Todo", `${run.label} Alpha`);
    await alpha.getByLabel("Move to").selectOption({ label: "Done" });
    await alpha.getByRole("button", { name: "Move" }).click();
    const pendingButton = alpha.getByRole("button", { name: "Moving..." });
    await expect(pendingButton).toBeVisible();
    await expect((await computedTextContrast(pendingButton)).ratio).toBeGreaterThanOrEqual(4.5);
    await expect((await computedTextContrast(alpha.getByLabel("Move to"))).ratio).toBeGreaterThanOrEqual(4.5);
    const alert = alpha.getByRole("alert");
    await expect(alert).toContainText("Archived records are read-only.");
    await expect((await computedTextContrast(alert)).ratio).toBeGreaterThanOrEqual(4.5);
    await expect(cardInLane(page, "Todo", `${run.label} Alpha`)).toBeVisible();
    await page.unroute("**/entities/**");
  } finally {
    await restoreE2eRunnerPreferences(runnerUserId, preferences);
    await page.emulateMedia({ colorScheme: "light" });
  }
});

test("field hard delete is blocked by saved view dependency and deleting a view preserves records", async () => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { work } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Dependency`,
    columnFieldDefinitionIds: [work.fields.title.id, work.fields.status.id],
  });

  const blocked = await supabase.rpc("delete_field_definition_if_safe", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: work.id,
    p_field_definition_id: work.fields.status.id,
  });
  expect(blocked.error).toBeNull();
  expect(blocked.data?.[0]?.deleted).toBe(false);
  expect(blocked.data?.[0]?.view_reference_count).toBe(1);

  const deleteViewResult = await supabase
    .from("entity_views")
    .delete()
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", work.id)
    .eq("id", viewId);
  expect(deleteViewResult.error).toBeNull();

  const records = await supabase
    .from("entity_records")
    .select("id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", work.id);
  expect(records.error).toBeNull();
  expect(records.data?.length).toBe(3);
});
