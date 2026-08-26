import { expect, type Locator, type Page, test } from "@playwright/test";
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
import { selectReactOption } from "./helpers/ui";

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];

test.beforeAll(async () => {
  await cleanupStaleE2eData();
});

test.afterAll(async () => {
  for (const run of runs) {
    await cleanupE2eRun(run);
  }
});

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

function processCard(page: Page, templateName: string): Locator {
  return page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: templateName, level: 3 }) })
    .last();
}

// A List row's own name renders as "<index>. <name>" -- anchoring on that
// avoids matching a different row whose routing-result summary merely
// mentions this step's name as its downstream target (e.g. "Continued to
// next step: Action step" on the row before it).
function stepRow(page: Page, stepName: string): Locator {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return page.getByRole("listitem").filter({
    has: page.getByText(new RegExp(`^\\d+\\. ${escaped}$`)),
  });
}

test.describe("process action nodes", () => {
  test("a create_record action executes automatically and the run advances with no manual click", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const origin = await createEntity(supabase, run, "Deliverable", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const followUp = await createEntity(supabase, run, "Follow-up Note", [
      { slug: "summary", name: "Summary", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({
      entity: origin,
      valuesBySlug: { name: "Widget rollout" },
    });
    const templateName = `${run.label} Action Template`;

    await page.goto("/processes/new");
    await page.locator("#process-template-name").fill(templateName);
    await selectReactOption(page.locator("#process-template-applies-to"), { value: origin.id });
    await page.getByRole("button", { name: "Remove" }).nth(1).click();
    await page.locator('input[name="stepName"]').nth(0).fill("Intake");
    await page.getByRole("button", { name: "+ Add action" }).click();
    await page.getByRole("button", { name: "+ Add step" }).click();

    const stepNameInputs = page.locator('input[name="stepName"]');
    await stepNameInputs.nth(1).fill("Action step");
    await stepNameInputs.nth(2).fill("Wrap up");

    await selectReactOption(page.getByLabel("Action type"), { value: "create_record" });
    await selectReactOption(page.getByLabel("Create in"), { label: followUp.name });
    await selectReactOption(page.getByLabel("Summary source", { exact: true }), { value: "source_field" });
    await selectReactOption(page.getByLabel("Summary source field"), { label: "Name" });

    await page.getByRole("button", { name: "Save Process Template" }).click();
    await expect(page.getByRole("link", { name: templateName })).toBeVisible();

    await page.goto(`/entities/${origin.id}/records/${recordId}`);
    await processCard(page, templateName).getByRole("button", { name: "Start process" }).click();
    await page.waitForURL(/\/process-runs\//);

    const intakeRow = stepRow(page, "Intake");
    await intakeRow.getByRole("button", { name: "Complete" }).click();

    // Nothing further to click: completing Intake activates the action node,
    // and it already ran and the run already advanced past it by the time
    // this completion request finished -- driven by the same activation
    // loop that runs inside completeProcessStepRunInRepository.
    const actionRow = stepRow(page, "Action step");
    await expect(actionRow.getByText("completed", { exact: true })).toBeVisible();
    await expect(actionRow.getByText("Action completed.")).toBeVisible();

    const wrapUpRow = stepRow(page, "Wrap up");
    await expect(wrapUpRow.getByText("active", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /^Action: Action step \(completed\)/ }),
    ).toBeVisible();

    const { data: createdRecords, error } = await supabase
      .from("entity_records")
      .select("values, originating_process_step_run_id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("entity_type_id", followUp.id);

    expect(error).toBeNull();
    expect(createdRecords).toHaveLength(1);
    expect(createdRecords?.[0]?.values?.[followUp.fields.summary.key]).toBe("Widget rollout");
    expect(createdRecords?.[0]?.originating_process_step_run_id).toBeTruthy();
  });

  test("a failed action stays visible and retryable, and succeeds once the underlying cause is fixed", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const person = await createEntity(supabase, run, "Person", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const origin = await createEntity(supabase, run, "Deliverable", [
      { slug: "name", name: "Name", type: "text", required: true },
      { slug: "owner", name: "Owner", type: "relation", relatedEntityTypeId: person.id },
    ]);
    const personRecordId = await createEntityRecord({
      entity: person,
      valuesBySlug: { name: "Jordan" },
    });
    const recordId = await createEntityRecord({
      entity: origin,
      valuesBySlug: { name: "Widget rollout" },
      // No owner relation yet -- the update_related_record action has
      // nothing to update against and must fail on first execution.
    });
    const templateName = `${run.label} Retry Template`;

    await page.goto("/processes/new");
    await page.locator("#process-template-name").fill(templateName);
    await selectReactOption(page.locator("#process-template-applies-to"), { value: origin.id });
    await page.getByRole("button", { name: "Remove" }).nth(1).click();
    await page.locator('input[name="stepName"]').nth(0).fill("Intake");
    await page.getByRole("button", { name: "+ Add action" }).click();

    const stepNameInputs = page.locator('input[name="stepName"]');
    await stepNameInputs.nth(1).fill("Notify owner");

    await selectReactOption(page.getByLabel("Action type"), { value: "update_related_record" });
    await selectReactOption(page.getByLabel("Related record"), { label: "Owner" });

    await page.getByRole("button", { name: "Save Process Template" }).click();
    await expect(page.getByRole("link", { name: templateName })).toBeVisible();

    await page.goto(`/entities/${origin.id}/records/${recordId}`);
    await processCard(page, templateName).getByRole("button", { name: "Start process" }).click();
    await page.waitForURL(/\/process-runs\//);

    const intakeRow = stepRow(page, "Intake");
    await intakeRow.getByRole("button", { name: "Complete" }).click();

    const actionRow = stepRow(page, "Notify owner");
    await expect(actionRow.getByText("Failed", { exact: true })).toBeVisible();
    await expect(actionRow.getByText(/has no record/)).toBeVisible();
    const retryButton = actionRow.getByRole("button", { name: "Retry" });
    await expect(retryButton).toBeVisible();

    // Fix the underlying cause out-of-band (as if a separate edit populated
    // it), then retry -- execution always reads the current record, never a
    // stale snapshot, so this must now succeed.
    await supabase
      .from("entity_record_relation_values")
      .insert({
        workspace_id: DEMO_WORKSPACE_ID,
        source_entity_type_id: origin.id,
        source_record_id: recordId,
        field_definition_id: origin.fields.owner.id,
        target_entity_type_id: person.id,
        target_record_id: personRecordId,
      });

    await retryButton.click();
    await expect(actionRow.getByText("completed", { exact: true })).toBeVisible();
    await expect(actionRow.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });
});
