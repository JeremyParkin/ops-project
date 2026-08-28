import { expect, type Locator, type Page } from "@playwright/test";
import type { TestEntity, TestField } from "./supabase-test-data";

// Every mutating form in the app submits a Server Action via useActionState,
// then either renders an inline confirmation in place or (server-side
// redirect) lands on a re-rendered destination page -- both round-trips
// normally resolve in well under a second, but occasionally exceed
// Playwright's default 5s expect timeout under a long single-worker
// full-suite run, never in isolation. Use this only for that exact
// assertion shape (confirming the result of a just-submitted mutation), not
// as a general-purpose "slow assertion" escape hatch.
const MUTATION_CONFIRMATION_TIMEOUT_MS = 15_000;

export async function expectAfterMutation(locator: Locator) {
  await expect(locator).toBeVisible({ timeout: MUTATION_CONFIRMATION_TIMEOUT_MS });
}

export async function gotoEntity(page: Page, entity: TestEntity, manage = false) {
  await page.goto(`/entities/${entity.id}${manage ? "?manage=true" : ""}`);
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("heading", { name: entity.name, exact: true }),
  ).toBeVisible();
}

export async function waitForWorkflowFormReady(page: Page) {
  const conditionField = page.locator('select[name^="conditionField:"]');
  const addConditionButton = page.getByRole("button", { name: "Add Condition" });

  await expect
    .poll(
      async () => {
        await addConditionButton.click();

        return conditionField.count();
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  await expect(conditionField).toBeVisible();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(conditionField).toHaveCount(0);
}

export function addRecordSection(page: Page, entity: TestEntity) {
  return page.locator("details#add-record").filter({
    has: page.getByText(`Add ${entity.name}`, { exact: true }),
  });
}

export async function fillRecordField(
  section: Locator,
  field: TestField,
  value: string,
) {
  const control = section.locator(`[name="${field.key}"]`);
  if (!(await control.isVisible())) {
    await section.locator("summary").click();
  }
  await control.fill(value);
}

export async function chooseRecordField(
  section: Locator,
  field: TestField,
  label: string,
) {
  const control = section.locator(`[name="${field.key}"]`);

  if (!(await control.isVisible())) {
    await section.locator("summary").click();
  }

  await selectReactOption(control, { label });
}

export async function submitAddRecord(page: Page, entity: TestEntity) {
  await addRecordSection(page, entity)
    .getByRole("button", { name: `Add ${entity.name}` })
    .click();
}

export function rowForText(page: Page, text: string) {
  return page.getByRole("row").filter({ hasText: text });
}

export async function expectTableValue(page: Page, value: string) {
  await expect(rowForText(page, value)).toBeVisible();
}

// Mapping field names are scoped per action as `<prefix>:<actionId>:<fieldId>`.
// Matching on prefix + suffix (rather than an exact name) keeps these helpers
// working regardless of which action a target field belongs to, as long as
// the field id itself is unique in the rendered form (true whenever two
// actions don't target the very same field).
export function workflowMappingType(page: Page, field: TestField) {
  return page.locator(`select[name^="mappingType:"][name$=":${field.id}"]`);
}

export function workflowSourceField(page: Page, field: TestField) {
  return page.locator(
    `select[name^="sourceFieldDefinitionId:"][name$=":${field.id}"]`,
  );
}

export function workflowConstantValue(page: Page, field: TestField) {
  return page.locator(`[name^="constantValue:"][name$=":${field.id}"]`);
}

export async function selectReactOption(
  locator: Locator,
  option: string | { value: string } | { label: string },
) {
  await expect(locator).toBeVisible();
  const selectedValue = await locator.evaluate((element, selectedOption) => {
    const select = element as HTMLSelectElement;
    const previousValue = select.value;
    const value =
      typeof selectedOption === "string"
        ? selectedOption
        : "value" in selectedOption
          ? selectedOption.value
          : Array.from(select.options).find(
              (optionElement) => optionElement.label === selectedOption.label,
            )?.value;

    if (value === undefined) {
      throw new Error("Unable to find select option.");
    }

    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    const trackedSelect = select as HTMLSelectElement & {
      _valueTracker?: { setValue: (value: string) => void };
    };

    valueSetter?.call(select, value);
    trackedSelect._valueTracker?.setValue(previousValue);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));

    return value;
  }, option);

  await expect(locator).toHaveValue(selectedValue);
}
