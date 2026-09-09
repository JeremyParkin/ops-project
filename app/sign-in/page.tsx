import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/workspace";
import { PASSWORD_RESET_SUCCESS_PARAM } from "@/lib/auth/password-recovery";
import { SignInForm } from "@/app/components/sign-in-form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/");

  const params = await searchParams;
  const passwordResetSuccess = params[PASSWORD_RESET_SUCCESS_PARAM] === "1";

  return (
    <main className="auth-page">
      <SignInForm passwordResetSuccess={passwordResetSuccess} />
    </main>
  );
}
