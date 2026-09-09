import { hasActiveRecoverySession } from "@/lib/auth/password-recovery";
import { ResetPasswordForm } from "@/app/components/reset-password-form";

export default async function ResetPasswordPage() {
  const canReset = await hasActiveRecoverySession();

  if (!canReset) {
    return (
      <main className="auth-page">
        <div className="auth-form">
          <h1>Reset link invalid or expired</h1>
          <p>This password reset link is no longer valid. Request a new one to continue.</p>
          <a href="/forgot-password" className="text-sm">
            Request a new reset link
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <ResetPasswordForm />
    </main>
  );
}
