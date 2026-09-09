"use client";

import { useActionState } from "react";

import { updatePasswordAction, type AuthFormState } from "@/app/auth-actions";

const initialState: AuthFormState = { message: "" };

// On success, updatePasswordAction ends the session and redirects to
// /sign-in itself (see app/auth-actions.ts) rather than returning a
// success state here -- there is no in-place "done" view for this form to
// render.
export function ResetPasswordForm() {
  const [state, action, pending] = useActionState(updatePasswordAction, initialState);

  return (
    <form action={action} className="auth-form">
      <h1>Choose a new password</h1>
      <label>
        New password
        <input name="password" type="password" autoComplete="new-password" minLength={8} required />
      </label>
      <label>
        Confirm new password
        <input
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </label>
      {state.message ? <p className="text-sm text-red-700">{state.message}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Updating..." : "Update password"}
      </button>
    </form>
  );
}
