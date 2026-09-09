import { ForgotPasswordForm } from "@/app/components/forgot-password-form";

// Deliberately does not redirect an already-signed-in visitor away (unlike
// /sign-in) -- a signed-in user may still legitimately want to reset their
// password (e.g. a shared workstation), and there's no reason to special-case
// that here.
export default function ForgotPasswordPage() {
  return (
    <main className="auth-page">
      <ForgotPasswordForm />
    </main>
  );
}
