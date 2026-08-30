"use client";

import { useActionState } from "react";
import {
  createWorkspaceRoleAction,
  deactivateWorkspaceMemberAction,
  deleteWorkspaceRoleAction,
  reactivateWorkspaceMemberAction,
  setWorkspaceMemberRoleAction,
  updateWorkspaceRoleAction,
  type WorkspaceRoleActionState,
} from "@/app/workspace-role-actions";
import {
  cancelWorkspaceInvitationAction,
  createWorkspaceInvitationAction,
  resendWorkspaceInvitationAction,
  type WorkspaceInvitationActionState,
} from "@/app/workspace-invitation-actions";
import { workspaceCapabilities, type WorkspaceCapability } from "@/lib/auth/capabilities";
import type {
  WorkspaceMemberWithRole,
  WorkspaceRole,
} from "@/lib/domain/workspace-role-repository";
import type { WorkspaceInvitation } from "@/lib/domain/workspace-invitation-repository";

const initialWorkspaceRoleActionState: WorkspaceRoleActionState = {
  success: false,
  message: "",
};

const initialWorkspaceInvitationActionState: WorkspaceInvitationActionState = {
  success: false,
  message: "",
};

const capabilityLabels: Record<WorkspaceCapability, string> = {
  "workspace.manage_members": "Manage members",
  "workspace.manage_roles": "Manage roles",
  "workspace.manage_organization": "Manage teams and organization",
  "workspace.manage_settings": "Manage workspace settings",
  "schema.manage": "Manage data model and fields",
  "automation.manage": "Manage automations and processes",
  "records.operate": "Create and update records",
  "processes.operate": "Operate processes and approvals",
  "operations.view": "View operational management information",
};

function ActionMessage({ state }: { state: WorkspaceRoleActionState }) {
  return state.message ? (
    <p className={`mt-2 text-sm ${state.success ? "text-status-sage" : "text-red-700"}`} role="status">
      {state.message}
    </p>
  ) : null;
}

function CapabilityChecklist({ selected }: { selected: WorkspaceCapability[] }) {
  return (
    <fieldset className="mt-3 grid gap-2 sm:grid-cols-2">
      <legend className="text-xs font-semibold uppercase tracking-wide text-stone">
        Capabilities
      </legend>
      {workspaceCapabilities.map((capability) => (
        <label key={capability} className="flex items-start gap-2 text-sm text-graphite">
          <input
            type="checkbox"
            name="capability"
            value={capability}
            defaultChecked={selected.includes(capability)}
            className="mt-0.5 h-4 w-4 border-grit"
          />
          <span>{capabilityLabels[capability]}</span>
        </label>
      ))}
    </fieldset>
  );
}

function MemberRoleForm({
  member,
  roles,
  currentUserId,
}: {
  member: WorkspaceMemberWithRole;
  roles: WorkspaceRole[];
  currentUserId: string;
}) {
  const [state, action, pending] = useActionState(
    setWorkspaceMemberRoleAction,
    initialWorkspaceRoleActionState,
  );
  const isCurrentUser = member.userId === currentUserId;
  const isDeactivated = Boolean(member.deactivatedAt);

  return (
    <form action={action} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <input type="hidden" name="userId" value={member.userId} />
      <div>
        <p className="font-medium text-graphite">
          {member.email}
          {isDeactivated ? <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-stone">Deactivated</span> : null}
        </p>
        <p className="mt-1 text-sm text-stone">Current role: {member.roleName}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`member-role-${member.userId}`}>
          Role for {member.email}
        </label>
        <select
          id={`member-role-${member.userId}`}
          name="roleId"
          defaultValue={member.roleId}
          disabled={isCurrentUser || isDeactivated || pending}
          className="h-10 border border-grit bg-paper px-3 text-sm text-graphite disabled:bg-chalk disabled:text-stone"
        >
          {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
        <button
          type="submit"
          disabled={isCurrentUser || isDeactivated || pending}
          className="h-10 border border-graphite px-3 text-sm font-medium text-graphite hover:bg-slab disabled:cursor-not-allowed disabled:border-grit disabled:text-stone"
        >
          {pending ? "Saving..." : "Save role"}
        </button>
      </div>
      {isCurrentUser ? <p className="text-sm text-stone">You cannot change your own role.</p> : null}
      <ActionMessage state={state} />
    </form>
  );
}

function MemberDeactivationControl({
  member,
  currentUserId,
}: {
  member: WorkspaceMemberWithRole;
  currentUserId: string;
}) {
  const [state, action, pending] = useActionState(
    member.deactivatedAt ? reactivateWorkspaceMemberAction : deactivateWorkspaceMemberAction,
    initialWorkspaceRoleActionState,
  );
  const isCurrentUser = member.userId === currentUserId;
  const isDeactivated = Boolean(member.deactivatedAt);

  if (isCurrentUser) return null;

  return (
    <form
      action={action}
      className="mt-1"
      onSubmit={(event) => {
        if (!isDeactivated && !window.confirm(`Deactivate ${member.email}? They will lose workspace access immediately.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="userId" value={member.userId} />
      <button
        type="submit"
        disabled={pending}
        className={`h-8 border px-2 text-xs font-medium disabled:cursor-not-allowed disabled:border-grit disabled:text-stone ${
          isDeactivated
            ? "border-graphite text-graphite hover:bg-slab"
            : "border-red-700 text-red-700 hover:bg-red-50"
        }`}
      >
        {pending ? "Saving..." : isDeactivated ? "Reactivate" : "Deactivate"}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

function RoleEditor({ role, roles, currentRoleId }: {
  role: WorkspaceRole;
  roles: WorkspaceRole[];
  currentRoleId: string;
}) {
  const [updateState, updateAction, updatePending] = useActionState(
    updateWorkspaceRoleAction,
    initialWorkspaceRoleActionState,
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteWorkspaceRoleAction,
    initialWorkspaceRoleActionState,
  );
  const isCurrentRole = role.id === currentRoleId;
  const alternatives = roles.filter((candidate) => candidate.id !== role.id);

  return (
    <article className="border border-grit bg-paper p-4">
      <form action={updateAction} className="grid gap-3">
        <input type="hidden" name="roleId" value={role.id} />
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone" htmlFor={`role-name-${role.id}`}>
              Role name
            </label>
            <input
              id={`role-name-${role.id}`}
              name="name"
              defaultValue={role.name}
              disabled={isCurrentRole || updatePending}
              required
              className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm text-graphite disabled:bg-chalk disabled:text-stone"
            />
          </div>
          <p className="pt-6 text-sm text-stone">{role.memberCount} member{role.memberCount === 1 ? "" : "s"}</p>
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-stone" htmlFor={`role-description-${role.id}`}>
            Description
          </label>
          <input
            id={`role-description-${role.id}`}
            name="description"
            defaultValue={role.description ?? ""}
            disabled={isCurrentRole || updatePending}
            className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm text-graphite disabled:bg-chalk disabled:text-stone"
          />
        </div>
        <div className={isCurrentRole ? "pointer-events-none opacity-60" : ""}>
          <CapabilityChecklist selected={role.capabilities} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-stone">
            {isCurrentRole ? "You cannot change your own role." : role.isBuiltin ? "Built-in compatibility role." : "Custom role."}
          </p>
          <button type="submit" disabled={isCurrentRole || updatePending} className="h-10 border border-graphite px-3 text-sm font-medium text-graphite hover:bg-slab disabled:cursor-not-allowed disabled:border-grit disabled:text-stone">
            {updatePending ? "Saving..." : "Save role"}
          </button>
        </div>
      </form>
      <ActionMessage state={updateState} />
      {alternatives.length ? (
        <form
          action={deleteAction}
          className="mt-4 flex flex-wrap items-end gap-2 border-t border-grit pt-4"
          onSubmit={(event) => {
            if (!window.confirm(`Delete ${role.name}? Assigned members will be moved to the selected role.`)) event.preventDefault();
          }}
        >
          <input type="hidden" name="roleId" value={role.id} />
          <label className="flex flex-col gap-1 text-sm text-stone" htmlFor={`role-replacement-${role.id}`}>
            Reassign members to
            <select id={`role-replacement-${role.id}`} name="replacementRoleId" defaultValue={alternatives[0]?.id} disabled={isCurrentRole || deletePending} className="h-10 border border-grit bg-paper px-3 text-sm text-graphite disabled:bg-chalk disabled:text-stone">
              {alternatives.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </label>
          <button type="submit" disabled={isCurrentRole || deletePending} className="h-10 border border-red-700 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-grit disabled:text-stone">
            {deletePending ? "Deleting..." : "Delete role"}
          </button>
        </form>
      ) : null}
      <ActionMessage state={deleteState} />
    </article>
  );
}

function InviteMemberForm({ roles }: { roles: WorkspaceRole[] }) {
  const [state, action, pending] = useActionState(
    createWorkspaceInvitationAction,
    initialWorkspaceInvitationActionState,
  );

  return (
    <form action={action} className="mt-5 border border-grit bg-slab/40 p-4">
      <h3 className="font-semibold text-graphite">Invite a member</h3>
      <p className="mt-1 text-sm text-stone">There is no email delivery yet -- share the generated link with them yourself.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
        <label className="text-sm text-graphite">
          Email
          <input type="email" name="email" required className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm" />
        </label>
        <label className="text-sm text-graphite">
          Role
          <select name="roleId" required defaultValue={roles[0]?.id} className="mt-1 h-10 border border-grit bg-paper px-3 text-sm">
            {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
          </select>
        </label>
        <button type="submit" disabled={pending} className="h-10 bg-brass px-4 text-sm font-semibold text-graphite hover:bg-brass-deep disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone">
          {pending ? "Inviting..." : "Send invite"}
        </button>
      </div>
      <ActionMessage state={state} />
      {state.link ? (
        <label className="mt-3 block text-sm text-graphite">
          Invitation link
          <input
            readOnly
            value={state.link}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm text-graphite"
          />
        </label>
      ) : null}
    </form>
  );
}

function InvitationRow({ invitation }: { invitation: WorkspaceInvitation }) {
  const [resendState, resendAction, resendPending] = useActionState(
    resendWorkspaceInvitationAction,
    initialWorkspaceInvitationActionState,
  );
  const [cancelState, cancelAction, cancelPending] = useActionState(
    cancelWorkspaceInvitationAction,
    initialWorkspaceInvitationActionState,
  );
  const isPending = invitation.status === "pending";
  const isExpired = isPending && new Date(invitation.expiresAt) <= new Date();

  return (
    <div className="border border-grit bg-paper p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-graphite">{invitation.email}</p>
          <p className="mt-1 text-sm text-stone">
            {invitation.roleName} &middot; {isExpired ? "Expired" : invitation.status}
          </p>
        </div>
        {isPending ? (
          <div className="flex items-center gap-2">
            <form action={resendAction}>
              <input type="hidden" name="invitationId" value={invitation.id} />
              <button type="submit" disabled={resendPending} className="h-8 border border-graphite px-2 text-xs font-medium text-graphite hover:bg-slab disabled:cursor-not-allowed disabled:border-grit disabled:text-stone">
                {resendPending ? "Resending..." : "Resend"}
              </button>
            </form>
            <form
              action={cancelAction}
              onSubmit={(event) => {
                if (!window.confirm(`Cancel the invitation to ${invitation.email}?`)) event.preventDefault();
              }}
            >
              <input type="hidden" name="invitationId" value={invitation.id} />
              <button type="submit" disabled={cancelPending} className="h-8 border border-red-700 px-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-grit disabled:text-stone">
                {cancelPending ? "Cancelling..." : "Cancel"}
              </button>
            </form>
          </div>
        ) : null}
      </div>
      {resendState.link ? (
        <label className="mt-2 block text-sm text-graphite">
          New invitation link
          <input
            readOnly
            value={resendState.link}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm text-graphite"
          />
        </label>
      ) : null}
      <ActionMessage state={resendState} />
      <ActionMessage state={cancelState} />
    </div>
  );
}

export function WorkspaceRoleManagement({
  roles,
  members,
  invitations,
  canManageMembers,
  canManageRoles,
  currentUserId,
  currentRoleId,
}: {
  roles: WorkspaceRole[];
  members: WorkspaceMemberWithRole[];
  invitations: WorkspaceInvitation[];
  canManageMembers: boolean;
  canManageRoles: boolean;
  currentUserId: string;
  currentRoleId: string;
}) {
  const [createState, createAction, createPending] = useActionState(
    createWorkspaceRoleAction,
    initialWorkspaceRoleActionState,
  );

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8">
      {canManageMembers ? (
        <section aria-labelledby="members-heading">
          <h2 id="members-heading" className="text-xl font-semibold text-graphite">Members</h2>
          <p className="mt-1 text-sm text-stone">Assign one workspace role to each member. Workspace access remains read-only by membership unless a role grants an operation.</p>
          <div className="mt-4 grid gap-3">
            {members.map((member) => (
              <div key={member.userId} className="border border-grit bg-paper p-3">
                <MemberRoleForm member={member} roles={roles} currentUserId={currentUserId} />
                <MemberDeactivationControl member={member} currentUserId={currentUserId} />
              </div>
            ))}
          </div>

          {invitations.length ? (
            <div className="mt-6">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-stone">Invitations</h3>
              <div className="mt-3 grid gap-2">
                {invitations.map((invitation) => <InvitationRow key={invitation.id} invitation={invitation} />)}
              </div>
            </div>
          ) : null}

          <InviteMemberForm roles={roles} />
        </section>
      ) : null}

      {canManageRoles ? (
        <section aria-labelledby="roles-heading" className="border-t border-grit pt-7">
          <h2 id="roles-heading" className="text-xl font-semibold text-graphite">Roles</h2>
          <p className="mt-1 text-sm text-stone">Capabilities determine what a role can change. Role names are descriptive only.</p>
          <div className="mt-4 grid gap-4">
            {roles.map((role) => <RoleEditor key={role.id} role={role} roles={roles} currentRoleId={currentRoleId} />)}
          </div>
          <form action={createAction} className="mt-5 border border-grit bg-slab/40 p-4">
            <h3 className="font-semibold text-graphite">Create custom role</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-sm text-graphite">Name<input name="name" required className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm" /></label>
              <label className="text-sm text-graphite">Description<input name="description" className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm" /></label>
            </div>
            <CapabilityChecklist selected={[]} />
            <button type="submit" disabled={createPending} className="mt-4 h-10 bg-brass px-4 text-sm font-semibold text-graphite hover:bg-brass-deep disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone">
              {createPending ? "Creating..." : "Create role"}
            </button>
            <ActionMessage state={createState} />
          </form>
        </section>
      ) : null}
    </div>
  );
}
