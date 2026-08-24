import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/workspace";
import { signOut } from "@/app/auth-actions";

export default async function NoWorkspacePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  return (
    <main className="auth-page">
      <section className="auth-form">
        <img
          src="/branding/kinema-L3-brass-black-text.svg"
          alt="Kinema"
          className="h-16 w-auto self-center"
        />
        <h1>No workspace access</h1>
        <p>Your account has not been assigned to a workspace.</p>
        <form action={signOut}>
          <button type="submit">Sign out</button>
        </form>
      </section>
    </main>
  );
}
