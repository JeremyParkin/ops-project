import { PersonalSettingsForm } from "@/app/components/personal-settings-form";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { resolveImpersonationContext } from "@/lib/auth/impersonation";
import { getUserPreferences } from "@/lib/domain/user-preferences-repository";

export const dynamic = "force-dynamic";

export default async function PersonalSettingsPage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const impersonation = await resolveImpersonationContext(workspaceId);
  const preferences = await getUserPreferences();
  return (
    <WorkspacePageLayout>
      <PageHeader eyebrow="Account" title="Personal settings" description="Control your personal appearance and display timezone." />
      {impersonation.isImpersonating ? (
        <section className="mx-auto w-full max-w-3xl border border-grit bg-white p-5">
          <h2 className="text-lg font-semibold text-graphite">Exit impersonation to change personal settings.</h2>
          <p className="mt-2 text-sm text-stone">Personal settings belong to the real signed-in account.</p>
        </section>
      ) : <PersonalSettingsForm preferences={preferences} />}
    </WorkspacePageLayout>
  );
}
