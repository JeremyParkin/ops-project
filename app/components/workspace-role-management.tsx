"use client";

import { useActionState } from "react";
import {
  createWorkspaceRoleAction,
  deleteWorkspaceRoleAction,
  setWorkspaceMemberRoleAction,
  updateWorkspaceRoleAction,
  type WorkspaceRoleActionState,
} from "@/app/workspace-role-actions";
import { workspaceCapabilities, type WorkspaceCapability } from "@/lib/auth/capabilities";
import type {
  WorkspaceMemberWithRole,
  WorkspaceRole,
} from "@/lib/domain/workspace-role-repository";

const initialWorkspaceRoleActionState: WorkspaceRoleActionState = {
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

  return (
    <form action={action} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <input type="hidden" name="userId" value={member.userId} />
      <div>
        <p className="font-medium text-graphite">{member.email}</p>
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
          disabled={isCurrentUser || pending}
          className="h-10 border border-grit bg-paper px-3 text-sm text-graphite disabled:bg-slab disabled:text-stone"
        >
          {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
        <button
          type="submit"
          disabled={isCurrentUser || pending}
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
              className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm text-graphite disabled:bg-slab"
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
            className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm text-graphite disabled:bg-slab"
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
            <select id={`role-replacement-${role.id}`} name="replacementRoleId" defaultValue={alternatives[0]?.id} disabled={isCurrentRole || deletePending} className="h-10 border border-grit bg-paper px-3 text-sm text-graphite disabled:bg-slab">
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

export function WorkspaceRoleManagement({
  roles,
  members,
  canManageMembers,
  canManageRoles,
  currentUserId,
  currentRoleId,
}: {
  roles: WorkspaceRole[];
  members: WorkspaceMemberWithRole[];
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
            {members.map((member) => <MemberRoleForm key={member.userId} member={member} roles={roles} currentUserId={currentUserId} />)}
          </div>
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
            <button type="submit" disabled={createPending} className="mt-4 h-10 bg-brass px-4 text-sm font-semibold text-graphite hover:bg-brass-deep disabled:cursor-not-allowed disabled:bg-slab">
              {createPending ? "Creating..." : "Create role"}
            </button>
            <ActionMessage state={createState} />
          </form>
        </section>
      ) : null}
    </div>
  );
}
