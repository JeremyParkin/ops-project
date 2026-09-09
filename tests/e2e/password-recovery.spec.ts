import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { requireE2eEnv } from "./helpers/env";
import { createSupabaseTestClient, deleteE2eUsers } from "./helpers/supabase-test-data";

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });

const userIds: string[] = [];

function uniqueEmail(label: string) {
  return `e2e-pwreset-${label}-${randomUUID()}@example.test`;
}

async function createUser(password: string) {
  const admin = createSupabaseTestClient();
  const email = uniqueEmail("user");
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create E2E user.");
  userIds.push(data.user.id);
  return { email, id: data.user.id };
}

// Generates a real token via the Admin API (no inbox needed) and returns the
// hashed token our /auth/confirm route consumes directly via verifyOtp --
// bypassing Supabase's own GoTrue /verify redirect hop, and with it any
// dependency on the project's dashboard redirect-URL allow-list matching
// whatever port this suite happens to run the app on. `type` lets tests
// generate a genuine non-recovery (e.g. magiclink) token too.
async function generateTokenHash(email: string, type: "recovery" | "magiclink" = "recovery") {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.auth.admin.generateLink({ type, email });
  if (error || !data) throw new Error(error?.message ?? "Unable to generate a link.");
  return data.properties.hashed_token;
}

test.afterAll(async () => {
  if (userIds.length > 0) await deleteE2eUsers(userIds);
});

test("forgot-password is reachable signed out and never reveals whether the account exists", async ({
  page,
}) => {
  const user = await createUser("Original-password-1!");

  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: "Forgot password?" })).toBeVisible();

  await page.getByLabel("Email").fill(user.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const knownMessage = await page.locator(".auth-form p").innerText();

  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(uniqueEmail("unknown"));
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const unknownMessage = await page.locator(".auth-form p").innerText();

  expect(knownMessage).toBe(unknownMessage);
});

test("direct navigation to /reset-password without a recovery session shows the invalid-link state, not a form", async ({
  page,
}) => {
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "Reset link invalid or expired" })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Request a new reset link" })).toBeVisible();
});

// /auth/confirm must fail closed for anything that isn't type=recovery --
// a genuine, successfully-verified non-recovery OTP link must not be able
// to establish the password_recovery_pending marker.
test("a non-recovery OTP confirmation (magiclink) never establishes recovery state", async ({
  page,
}) => {
  const user = await createUser("Original-password-1!");
  const tokenHash = await generateTokenHash(user.email, "magiclink");

  await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=magiclink`);
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(page.getByRole("heading", { name: "Reset link invalid or expired" })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveCount(0);
});

test("a genuine recovery link establishes a session, enforces confirmation match, completes the reset, and signs out to /sign-in", async ({
  page,
}) => {
  const initialPassword = "Original-password-1!";
  const newPassword = "New-password-1!";
  const user = await createUser(initialPassword);

  const tokenHash = await generateTokenHash(user.email);
  await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=recovery`);
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();

  // A mismatch must not consume or otherwise destroy the recovery state --
  // the form must still be usable immediately afterward.
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill("Different-password-1!");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("Passwords do not match.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();

  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Update password" }).click();

  // The action ends the session itself and redirects here -- landing on
  // /sign-in (rather than being bounced to / by the proxy's
  // already-authenticated check) is itself proof the local session was
  // actually terminated, not left silently alive.
  await expect(page).toHaveURL(/\/sign-in\?passwordReset=1$/);
  await expect(
    page.getByText("Your password has been changed. Sign in with your new password."),
  ).toBeVisible();

  // The completed episode is fully closed out: revisiting /reset-password
  // no longer offers a form (session gone, marker cleared either way).
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "Reset link invalid or expired" })).toBeVisible();

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(newPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(initialPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
});

test("a reused recovery token no longer works on a second visit", async ({ page }) => {
  const user = await createUser("Original-password-1!");
  const tokenHash = await generateTokenHash(user.email);

  await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=recovery`);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();

  await page.context().clearCookies();
  await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=recovery`);
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(page.getByRole("heading", { name: "Reset link invalid or expired" })).toBeVisible();
});

test("sign-in shows an error message on invalid credentials instead of silently redirecting", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(uniqueEmail("nonexistent"));
  await page.getByLabel("Password").fill("wrong-password-1!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
});

// The page hiding the form is not the security boundary -- updatePasswordAction
// must reject a direct call on its own. This replays a real, captured
// Next.js Server Action request (same `next-action` reference, same
// multipart wire shape a genuine form submission produces) from a completely
// different, ordinary signed-in session that never went through recovery and
// holds no password_recovery_pending marker. The action reference itself is
// a static per-build identifier, not scoped to the session that first
// rendered it, so this is exactly the bypass a page-only check would miss.
test("calling updatePasswordAction directly from an ordinary session without the recovery marker is rejected", async ({
  page,
  baseURL,
}) => {
  const recoveryOwner = await createUser("Recovery-owner-password-1!");
  const tokenHash = await generateTokenHash(recoveryOwner.email);

  let capturedActionId: string | null = null;
  const captureAction = (req: import("@playwright/test").Request) => {
    if (req.method() === "POST" && req.url() === `${baseURL}/reset-password`) {
      capturedActionId = req.headers()["next-action"] ?? null;
    }
  };
  page.on("request", captureAction);

  await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=recovery`);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  // A harmless mismatched submission is enough to observe a real request to
  // the action without actually mutating recoveryOwner's password.
  await page.getByLabel("New password", { exact: true }).fill("Harmless-probe-1!");
  await page.getByLabel("Confirm new password").fill("Different-probe-1!");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("Passwords do not match.")).toBeVisible();
  page.off("request", captureAction);

  if (!capturedActionId) {
    throw new Error("Failed to capture updatePasswordAction's Next.js action reference.");
  }

  // Switch to a completely different, ordinary authenticated session with
  // no recovery episode at all.
  const victimPassword = "Victim-original-password-1!";
  const victim = await createUser(victimPassword);
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(victim.email);
  await page.getByLabel("Password").fill(victimPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/sign-in$/);

  const attackerPassword = "Attacker-supplied-1!";
  await page.evaluate(
    async ({ actionId, password }) => {
      const boundary = "----kinemaE2eProbeBoundary";
      const part = (name: string, value: string) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
      const body =
        part("_1_$ACTION_REF_1", "") +
        part("_1_$ACTION_1:0", JSON.stringify({ id: actionId, bound: "$@1" })) +
        part("_1_$ACTION_1:1", JSON.stringify([{ message: "" }])) +
        part("_1_$ACTION_KEY", "kE2eProbe00000000000000000000000") +
        part("_1_password", password) +
        part("_1_confirmPassword", password) +
        `--${boundary}--\r\n`;

      await fetch("/reset-password", {
        method: "POST",
        credentials: "include",
        headers: {
          "next-action": actionId,
          accept: "text/x-component",
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
    },
    { actionId: capturedActionId, password: attackerPassword },
  );

  // The mutation must not have happened regardless of how the raw response
  // reads: the victim's real password still works, the attacker-supplied
  // one does not.
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(victim.email);
  await page.getByLabel("Password").fill(victimPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/sign-in$/);

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(victim.email);
  await page.getByLabel("Password").fill(attackerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
});

// Exercises updatePasswordAction's other-session revocation directly against
// the Auth API (no browser needed for this one): session A predates the
// reset, session B is the recovery session that changes the password. Only
// A's refresh is expected to fail afterward -- signOut({scope:'others'})
// revokes refresh tokens, not the still-unexpired access token JWT already
// issued to A (there is no way to revoke that before it naturally expires),
// so refreshSession() is the correct, honest thing to assert on here rather
// than an immediate authenticated request with the old access token.
test("updating a password revokes other sessions' ability to refresh", async () => {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const initialPassword = "Original-password-1!";
  const newPassword = "New-password-1!";
  const user = await createUser(initialPassword);

  const clientA = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { error: signInError } = await clientA.auth.signInWithPassword({
    email: user.email,
    password: initialPassword,
  });
  if (signInError) throw new Error(signInError.message);
  const { data: sessionAData } = await clientA.auth.getSession();
  const refreshTokenA = sessionAData.session?.refresh_token;
  if (!refreshTokenA) throw new Error("Expected session A to have a refresh token.");

  const tokenHash = await generateTokenHash(user.email);
  const clientB = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { error: verifyError } = await clientB.auth.verifyOtp({
    token_hash: tokenHash,
    type: "recovery",
  });
  if (verifyError) throw new Error(verifyError.message);

  const { error: updateError } = await clientB.auth.updateUser({ password: newPassword });
  if (updateError) throw new Error(updateError.message);
  const { error: signOutOthersError } = await clientB.auth.signOut({ scope: "others" });
  if (signOutOthersError) throw new Error(signOutOthersError.message);

  const clientARefresh = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { error: refreshError } = await clientARefresh.auth.refreshSession({
    refresh_token: refreshTokenA,
  });
  expect(refreshError).not.toBeNull();
});
