import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/workspace";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function SignInPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  async function signIn(formData: FormData) {
    "use server";

    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) redirect("/sign-in?error=invalid-credentials");
    redirect("/");
  }

  return (
    <main className="auth-page">
      <form action={signIn} className="auth-form">
        <h1>Sign in</h1>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
