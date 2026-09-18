import { expect, test } from "@playwright/test";
import { createSupabaseTestClient, DEMO_WORKSPACE_ID } from "./helpers/supabase-test-data";

// Uses the suite's default pre-authenticated E2E runner session (already a
// member of DEMO_WORKSPACE_ID on the built-in, full-capability role) rather
// than a fresh signed-out fixture -- this is a narrow rendering fix, not an
// authorization test, so no isolated workspace/user setup is needed.
test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  // DEMO_WORKSPACE_ID is shared across the whole E2E suite (e.g.
  // recurrence-commit.test.ts explicitly relies on its timezone staying at
  // the untouched UTC default) -- restore it regardless of pass/fail so
  // this test never leaves shared state behind for other specs.
  const admin = createSupabaseTestClient();
  await admin.from("workspaces").update({ timezone: "UTC" }).eq("id", DEMO_WORKSPACE_ID);
});

test("workspace timezone selector offers multiple options and persists a non-UTC selection", async ({ page }) => {
  await page.goto("/settings");

  // Scoped to this one section -- DEMO_WORKSPACE_ID's settings page has many
  // other "Save"-labeled buttons (Person type, each role editor, etc.).
  const section = page.locator("section", { hasText: "Workspace timezone" });
  const select = section.getByLabel("Timezone");
  const optionValues = await select.locator("option").allTextContents();
  expect(optionValues.length).toBeGreaterThan(1);
  expect(optionValues).toContain("America/Toronto");

  await select.selectOption("America/Toronto");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByText("Workspace timezone updated.")).toBeVisible();

  await page.reload();
  await expect(page.locator("section", { hasText: "Workspace timezone" }).getByLabel("Timezone")).toHaveValue(
    "America/Toronto",
  );
});
