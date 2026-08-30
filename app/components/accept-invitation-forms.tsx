"use client";

import { useActionState } from "react";
import {
  acceptInvitationCreateAccountAction,
  acceptInvitationDirectAction,
  acceptInvitationSignInAction,
  type AcceptInvitationActionState,
} from "@/app/workspace-invitation-actions";

const initialState: AcceptInvitationActionState = { message: "" };

function FormMessage({ state }: { state: AcceptInvitationActionState }) {
  return state.message ? <p className="text-sm text-red-700">{state.message}</p> : null;
}

export function CreateAccountForm({ token, email }: { token: string; email: string }) {
  const [state, action, pending] = useActionState(acceptInvitationCreateAccountAction, initialState);

  return (
    <form action={action} className="auth-form">
      <h1>Create your account</h1>
      <p>{email} was invited to join a Kinema workspace. Choose a password to finish setting up your account.</p>
      <input type="hidden" name="token" value={token} />
      <label>
        Email
        <input value={email} disabled readOnly />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="new-password" minLength={8} required />
      </label>
      <FormMessage state={state} />
      <button type="submit" disabled={pending}>
        {pending ? "Creating account..." : "Create account and join"}
      </button>
    </form>
  );
}

export function SignInAndAcceptForm({ token, email }: { token: string; email: string }) {
  const [state, action, pending] = useActionState(acceptInvitationSignInAction, initialState);

  return (
    <form action={action} className="auth-form">
      <h1>Sign in to accept</h1>
      <p>{email} was invited to join a Kinema workspace. Sign in with your existing password to accept.</p>
      <input type="hidden" name="token" value={token} />
      <label>
        Email
        <input value={email} disabled readOnly />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <FormMessage state={state} />
      <button type="submit" disabled={pending}>
        {pending ? "Signing in..." : "Sign in and join"}
      </button>
    </form>
  );
}

export function DirectAcceptForm({ token, workspaceName }: { token: string; workspaceName: string }) {
  const [state, action, pending] = useActionState(acceptInvitationDirectAction, initialState);

  return (
    <form action={action} className="auth-form">
      <h1>Join {workspaceName}</h1>
      <p>You&rsquo;re signed in with the invited email address.</p>
      <input type="hidden" name="token" value={token} />
      <FormMessage state={state} />
      <button type="submit" disabled={pending}>
        {pending ? "Joining..." : "Accept invitation"}
      </button>
    </form>
  );
}
