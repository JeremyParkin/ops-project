import { getCurrentUser } from "@/lib/auth/workspace";
import { getInvitationByToken } from "@/lib/domain/workspace-invitation-repository";
import {
  CreateAccountForm,
  DirectAcceptForm,
  SignInAndAcceptForm,
} from "@/app/components/accept-invitation-forms";

function InvitationMessage({ heading, body }: { heading: string; body: string }) {
  return (
    <main className="auth-page">
      <div className="auth-form">
        <h1>{heading}</h1>
        <p>{body}</p>
      </div>
    </main>
  );
}

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token) {
    return <InvitationMessage heading="Invitation not found" body="This invitation link is missing its token." />;
  }

  const invitation = await getInvitationByToken({ token });
  if (!invitation) {
    return <InvitationMessage heading="Invitation not found" body="This invitation link is invalid." />;
  }
  if (invitation.status === "cancelled") {
    return <InvitationMessage heading="Invitation cancelled" body="This invitation has been cancelled by a workspace administrator." />;
  }
  if (invitation.status === "pending" && new Date(invitation.expiresAt) <= new Date()) {
    return <InvitationMessage heading="Invitation expired" body="Ask a workspace administrator to send you a new invitation." />;
  }

  const currentUser = await getCurrentUser();
  if (currentUser?.email) {
    if (currentUser.email.toLowerCase() === invitation.email) {
      if (invitation.status === "accepted") {
        return <InvitationMessage heading="Already joined" body={`You're already a member of ${invitation.workspaceName}.`} />;
      }
      return (
        <main className="auth-page">
          <DirectAcceptForm token={token} workspaceName={invitation.workspaceName} />
        </main>
      );
    }
    return (
      <InvitationMessage
        heading="Signed in with a different email"
        body={`This invitation was sent to ${invitation.email}, but you're signed in as ${currentUser.email}. Sign out and try again.`}
      />
    );
  }

  if (invitation.status === "accepted") {
    return <InvitationMessage heading="Already accepted" body="This invitation has already been accepted. Sign in to continue." />;
  }

  return (
    <main className="auth-page">
      {invitation.emailHasAccount ? (
        <SignInAndAcceptForm token={token} email={invitation.email} />
      ) : (
        <CreateAccountForm token={token} email={invitation.email} />
      )}
    </main>
  );
}
