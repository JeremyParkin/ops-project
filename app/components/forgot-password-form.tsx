"use client";

import { useActionState } from "react";

import { requestPasswordResetAction, type AuthFormState } from "@/app/auth-actions";

const initialState: AuthFormState = { message: "" };

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordResetAction, initialState);

  if (state.success) {
    return (
      <div className="auth-form">
        <h1>Check your email</h1>
        <p>{state.message}</p>
        <a href="/sign-in" className="text-sm">
          Back to sign in
        </a>
      </div>
    );
  }

  return (
    <form action={action} className="auth-form">
      <h1>Forgot password?</h1>
      <p>Enter your email and we&rsquo;ll send you a link to reset your password.</p>
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      {state.message ? <p className="text-sm text-red-700">{state.message}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Sending..." : "Send reset link"}
      </button>
      <a href="/sign-in" className="text-sm">
        Back to sign in
      </a>
    </form>
  );
}
