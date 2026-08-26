import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { createSupabaseTestClient, DEMO_WORKSPACE_ID } from "./helpers/supabase-test-data";
import { E2E_AUTH_STORAGE_STATE } from "./helpers/auth-state";

const email = "e2e-runner@ops-project.test";
const password = "E2E-runner-password-2026";

export default async function globalSetup() {
  const admin = createSupabaseTestClient();
  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const user of existing.users.filter((candidate) => candidate.email === email)) {
    await admin.auth.admin.deleteUser(user.id);
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create E2E runner.");

  const { data: compatibilityRole, error: roleError } = await admin
    .from("workspace_roles")
    .select("id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("is_builtin", true)
    .limit(1)
    .single();
  if (roleError || !compatibilityRole) {
    throw new Error(roleError?.message ?? "Unable to load the E2E workspace role.");
  }

  const { error: membershipError } = await admin
    .from("workspace_memberships")
    .insert({
      workspace_id: DEMO_WORKSPACE_ID,
      user_id: data.user.id,
      role_id: compatibilityRole.id,
    });
  if (membershipError) throw new Error(membershipError.message);

  mkdirSync(path.dirname(E2E_AUTH_STORAGE_STATE), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100" });
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
  await page.context().storageState({ path: E2E_AUTH_STORAGE_STATE });
  await browser.close();

  return async () => {
    const cleanup = createSupabaseTestClient();
    await cleanup.auth.admin.deleteUser(data.user.id);
  };
}
