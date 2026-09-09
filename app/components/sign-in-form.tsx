"use client";

import { useActionState } from "react";

import { signInAction, type AuthFormState } from "@/app/auth-actions";

const initialState: AuthFormState = { message: "" };

export function SignInForm({ passwordResetSuccess }: { passwordResetSuccess?: boolean }) {
  const [state, action, pending] = useActionState(signInAction, initialState);

  return (
    <form action={action} className="auth-form">
      <img
        src="/branding/kinema-L3-black-text.svg"
        alt="Kinema"
        className="h-16 w-auto self-center"
      />
      <h1>Sign in</h1>
      {passwordResetSuccess ? (
        <p className="text-sm">Your password has been changed. Sign in with your new password.</p>
      ) : null}
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {state.message ? <p className="text-sm text-red-700">{state.message}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Signing in..." : "Sign in"}
      </button>
      <a href="/forgot-password" className="text-sm">
        Forgot password?
      </a>
    </form>
  );
}
