import { expect, test } from "@playwright/test";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";

type PreferenceRow = {
  user_id: string;
  theme: "system" | "light" | "dark";
  timezone: string | null;
  notify_comment_mentions: boolean;
  notify_input_request_status_updates: boolean;
  display_name: string | null;
};

let runnerUserId = "";
let originalPreferences: PreferenceRow | null = null;

test.beforeAll(async () => {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(error.message);
  const runner = data.users.find((user) => user.email === E2E_RUNNER_EMAIL);
  if (!runner) throw new Error("Unable to find E2E runner user.");
  runnerUserId = runner.id;

  const preferences = await admin
    .from("user_preferences")
    .select("user_id, theme, timezone, notify_comment_mentions, notify_input_request_status_updates, display_name")
    .eq("user_id", runnerUserId)
    .maybeSingle<PreferenceRow>();
  if (preferences.error) throw new Error(preferences.error.message);
  originalPreferences = preferences.data ?? null;
});

test.afterAll(async () => {
  if (!runnerUserId) return;
  const admin = createSupabaseTestClient();
  if (originalPreferences) {
    await admin.from("user_preferences").upsert(originalPreferences);
  } else {
    await admin.from("user_preferences").delete().eq("user_id", runnerUserId);
  }
});

test("personal settings saves and normalizes display names without regressing existing preferences", async ({
  page,
}) => {
  test.setTimeout(45_000);

  const admin = createSupabaseTestClient();
  const displayName = "E2E Display Name";

  await page.goto("/settings/personal");
  await page.getByLabel("Display name").fill(`  ${displayName}  `);
  await page.getByLabel("Appearance").selectOption("dark");
  await page.getByLabel("Display timezone").fill("America/Toronto");
  await page.getByLabel("Mentions").check();
  await page.getByLabel("Request-for-Input updates").uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText("Personal settings updated.");

  const saved = await admin
    .from("user_preferences")
    .select("theme, timezone, notify_comment_mentions, notify_input_request_status_updates, display_name")
    .eq("user_id", runnerUserId)
    .single<Omit<PreferenceRow, "user_id">>();
  expect(saved.error).toBeNull();
  expect(saved.data).toMatchObject({
    theme: "dark",
    timezone: "America/Toronto",
    notify_comment_mentions: true,
    notify_input_request_status_updates: false,
    display_name: displayName,
  });

  await page.getByLabel("Display name").fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText("Personal settings updated.");
  await expect.poll(async () => {
    const blanked = await admin
      .from("user_preferences")
      .select("display_name")
      .eq("user_id", runnerUserId)
      .single<{ display_name: string | null }>();
    if (blanked.error) throw new Error(blanked.error.message);
    return blanked.data?.display_name ?? null;
  }).toBeNull();

  await expect(page.getByLabel("Display name")).toHaveAttribute("maxlength", "120");
});
