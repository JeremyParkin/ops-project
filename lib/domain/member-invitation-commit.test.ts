// DB/RPC-level coverage for Phase 8E.1 Member/Invitation Lifecycle: invitation
// create/resend/cancel/accept (including expired, wrong-email, and
// already-accepted-idempotent cases), member deactivation/reactivation,
// deactivated-member exclusion from workspace access, and the last-admin
// guard on deactivation. Requires migration 0067 applied.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];

function uniqueEmail(label: string) {
  return `e2e-invite-${label}-${randomUUID()}@example.test`;
}

async function createUserWithEmail(email: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `Invite-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user.");
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function createUser(label: string): Promise<User> {
  return createUserWithEmail(uniqueEmail(label));
}

async function authenticatedClient(user: User): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return client;
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }
  return id;
}

async function createWorkspace(name: string) {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error } = await admin.from("workspaces").insert({ id: workspaceId, name: `${name} ${workspaceId.slice(0, 8)}` });
  if (error) throw new Error(error.message);
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
}

async function addMembership(workspaceId: string, userId: string, roleId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: userId, role_id: roleId });
  if (error) throw new Error(error.message);
}

type Fixture = {
  workspaceId: string;
  fullAdminRoleId: string;
  memberManagerRoleId: string;
  plainMemberRoleId: string;
  adminOne: User;
  memberManager: User;
  plainMember: User;
  otherWorkspaceId: string;
};

let fixture: Fixture;

beforeAll(async () => {
  const workspaceId = await createWorkspace("E2E Invitations");
  const otherWorkspaceId = await createWorkspace("E2E Invitations Other");

  const fullAdminRoleId = await createRole(workspaceId, "Administrator", ["workspace.manage_members", "workspace.manage_roles"]);
  const memberManagerRoleId = await createRole(workspaceId, "Member manager", ["workspace.manage_members"]);
  const plainMemberRoleId = await createRole(workspaceId, "Member", []);
  const otherAdminRoleId = await createRole(otherWorkspaceId, "Administrator", ["workspace.manage_members", "workspace.manage_roles"]);

  const adminOne = await createUser("admin-one");
  const memberManager = await createUser("member-manager");
  const plainMember = await createUser("plain-member");
  const otherAdmin = await createUser("other-admin");

  await addMembership(workspaceId, adminOne.id, fullAdminRoleId);
  await addMembership(workspaceId, memberManager.id, memberManagerRoleId);
  await addMembership(workspaceId, plainMember.id, plainMemberRoleId);
  await addMembership(otherWorkspaceId, otherAdmin.id, otherAdminRoleId);

  fixture = { workspaceId, fullAdminRoleId, memberManagerRoleId, plainMemberRoleId, adminOne, memberManager, plainMember, otherWorkspaceId };
}, 30_000);

afterAll(async () => {
  const admin = createSupabaseTestClient();
  const failures: string[] = [];

  if (createdWorkspaceIds.length) {
    const { error } = await admin.from("workspaces").delete().in("id", createdWorkspaceIds);
    if (error) failures.push(error.message);
  }
  for (const userId of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) failures.push(`${userId}: ${error.message}`);
  }

  if (failures.length > 0) {
    throw new Error(`member-invitation-commit afterAll cleanup: ${failures.length} failure(s):\n${failures.join("\n")}`);
  }
}, 30_000);

describe("invitation lifecycle", () => {
  it("creates an invitation and rejects a duplicate pending invite for the same email", async () => {
    const admin = await authenticatedClient(fixture.adminOne);
    const email = uniqueEmail("dup-target");

    const first = await admin.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_email: email, p_role_id: fixture.plainMemberRoleId,
    });
    expect(first.error).toBeNull();
    expect(typeof first.data).toBe("string");

    const duplicate = await admin.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_email: email, p_role_id: fixture.plainMemberRoleId,
    });
    expect(duplicate.error?.message).toContain("already pending");
  });

  it("rejects invitation creation without workspace.manage_members", async () => {
    const member = await authenticatedClient(fixture.plainMember);
    const result = await member.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_email: uniqueEmail("denied"), p_role_id: fixture.plainMemberRoleId,
    });
    expect(result.error?.message).toContain("workspace.manage_members");
  });

  it("resend rotates the token so the previous link no longer resolves", async () => {
    const admin = await authenticatedClient(fixture.adminOne);
    const email = uniqueEmail("resend-target");
    const created = await admin.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_email: email, p_role_id: fixture.plainMemberRoleId,
    });
    expect(created.error).toBeNull();
    const originalToken = created.data as string;

    const { data: invitationRow, error: lookupError } = await createSupabaseTestClient()
      .from("workspace_invitations").select("id").eq("workspace_id", fixture.workspaceId).eq("email", email).single();
    expect(lookupError).toBeNull();

    const resent = await admin.rpc("resend_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_invitation_id: invitationRow!.id,
    });
    expect(resent.error).toBeNull();
    const newToken = resent.data as string;
    expect(newToken).not.toBe(originalToken);

    const staleLookup = await createSupabaseTestClient().rpc("get_invitation_by_token", { p_token: originalToken });
    expect(staleLookup.data).toEqual([]);
    const freshLookup = await createSupabaseTestClient().rpc("get_invitation_by_token", { p_token: newToken });
    expect(freshLookup.data?.[0]?.email).toBe(email);
  });

  it("cancel prevents acceptance and further resend", async () => {
    const admin = await authenticatedClient(fixture.adminOne);
    const email = uniqueEmail("cancel-target");
    const created = await admin.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_email: email, p_role_id: fixture.plainMemberRoleId,
    });
    const token = created.data as string;
    const { data: invitationRow } = await createSupabaseTestClient()
      .from("workspace_invitations").select("id").eq("workspace_id", fixture.workspaceId).eq("email", email).single();

    const cancelled = await admin.rpc("cancel_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_invitation_id: invitationRow!.id,
    });
    expect(cancelled.error).toBeNull();

    const resendAfterCancel = await admin.rpc("resend_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_invitation_id: invitationRow!.id,
    });
    expect(resendAfterCancel.error?.message).toContain("Pending invitation not found");

    const invitee = await createUserWithEmail(email);
    const inviteeClient = await authenticatedClient(invitee);
    const accept = await inviteeClient.rpc("accept_workspace_invitation_authorized", { p_token: token });
    expect(accept.error?.message).toContain("cancelled");
  });

  it("accept rejects a signed-in user whose email does not match the invitation", async () => {
    const admin = await authenticatedClient(fixture.adminOne);
    const invitedEmail = uniqueEmail("mismatch-target");
    const created = await admin.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_email: invitedEmail, p_role_id: fixture.plainMemberRoleId,
    });
    const token = created.data as string;

    const wrongUser = await createUser("mismatch-wrong");
    const wrongClient = await authenticatedClient(wrongUser);
    const accept = await wrongClient.rpc("accept_workspace_invitation_authorized", { p_token: token });
    expect(accept.error?.message).toContain("different email address");
  });

  it("rejects acceptance of an expired invitation", async () => {
    const admin = await authenticatedClient(fixture.adminOne);
    const email = uniqueEmail("expired-target");
    const created = await admin.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_email: email, p_role_id: fixture.plainMemberRoleId,
    });
    const token = created.data as string;

    const serviceAdmin = createSupabaseTestClient();
    const { error: expireError } = await serviceAdmin
      .from("workspace_invitations")
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("workspace_id", fixture.workspaceId).eq("email", email);
    expect(expireError).toBeNull();

    const invitee = await createUserWithEmail(email);
    const inviteeClient = await authenticatedClient(invitee);
    const accept = await inviteeClient.rpc("accept_workspace_invitation_authorized", { p_token: token });
    expect(accept.error?.message).toContain("expired");
  });

  it("accept creates a membership with the invited role and is idempotent on a second call", async () => {
    const admin = await authenticatedClient(fixture.adminOne);
    const email = uniqueEmail("accept-target");
    const created = await admin.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_email: email, p_role_id: fixture.plainMemberRoleId,
    });
    const token = created.data as string;

    const invitee = await createUserWithEmail(email);
    const inviteeClient = await authenticatedClient(invitee);
    const firstAccept = await inviteeClient.rpc("accept_workspace_invitation_authorized", { p_token: token });
    expect(firstAccept.error).toBeNull();
    expect(firstAccept.data).toBe(fixture.workspaceId);

    const { data: membershipRow, error: membershipError } = await createSupabaseTestClient()
      .from("workspace_memberships").select("role_id, deactivated_at")
      .eq("workspace_id", fixture.workspaceId).eq("user_id", invitee.id).single();
    expect(membershipError).toBeNull();
    expect(membershipRow?.role_id).toBe(fixture.plainMemberRoleId);
    expect(membershipRow?.deactivated_at).toBeNull();

    const secondAccept = await inviteeClient.rpc("accept_workspace_invitation_authorized", { p_token: token });
    expect(secondAccept.error).toBeNull();
    expect(secondAccept.data).toBe(fixture.workspaceId);
  });

  it("re-inviting a previously deactivated member reactivates them with the newly invited role", async () => {
    const admin = await authenticatedClient(fixture.adminOne);
    const email = uniqueEmail("reactivate-target");

    const firstInvite = await admin.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_email: email, p_role_id: fixture.plainMemberRoleId,
    });
    const invitee = await createUserWithEmail(email);
    const inviteeClient = await authenticatedClient(invitee);
    const firstAccept = await inviteeClient.rpc("accept_workspace_invitation_authorized", { p_token: firstInvite.data as string });
    expect(firstAccept.error).toBeNull();

    const deactivate = await admin.rpc("deactivate_workspace_member_authorized", {
      p_workspace_id: fixture.workspaceId, p_user_id: invitee.id,
    });
    expect(deactivate.error).toBeNull();

    // is_workspace_member is the real access boundary this migration
    // enforces (excludes deactivated_at rows) -- the raw
    // workspace_memberships_select_own RLS policy deliberately still lets a
    // user see their own row regardless of deactivation, so that is not the
    // right thing to assert here.
    const accessCheckAfterDeactivation = await inviteeClient.rpc("list_workspace_member_identities_authorized", {
      p_workspace_id: fixture.workspaceId,
    });
    expect(accessCheckAfterDeactivation.error?.message).toContain("Workspace access denied");

    const secondInvite = await admin.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: fixture.workspaceId, p_email: email, p_role_id: fixture.memberManagerRoleId,
    });
    expect(secondInvite.error).toBeNull();
    const secondAccept = await inviteeClient.rpc("accept_workspace_invitation_authorized", { p_token: secondInvite.data as string });
    expect(secondAccept.error).toBeNull();

    const { data: membershipRow } = await createSupabaseTestClient()
      .from("workspace_memberships").select("role_id, deactivated_at")
      .eq("workspace_id", fixture.workspaceId).eq("user_id", invitee.id).single();
    expect(membershipRow?.role_id).toBe(fixture.memberManagerRoleId);
    expect(membershipRow?.deactivated_at).toBeNull();
  });

  it("cross-workspace isolation: an admin from another workspace cannot manage this workspace's invitations or members", async () => {
    const otherWorkspaceAdmin = await authenticatedClient(fixture.plainMember);
    const invite = await otherWorkspaceAdmin.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: fixture.otherWorkspaceId, p_email: uniqueEmail("cross"), p_role_id: fixture.plainMemberRoleId,
    });
    expect(invite.error?.message).toContain("Workspace access denied");

    const deactivate = await otherWorkspaceAdmin.rpc("deactivate_workspace_member_authorized", {
      p_workspace_id: fixture.otherWorkspaceId, p_user_id: fixture.adminOne.id,
    });
    expect(deactivate.error?.message).toContain("Workspace access denied");
  });
});

describe("member deactivation and reactivation", () => {
  it("blocks self-deactivation", async () => {
    const admin = await authenticatedClient(fixture.adminOne);
    const result = await admin.rpc("deactivate_workspace_member_authorized", {
      p_workspace_id: fixture.workspaceId, p_user_id: fixture.adminOne.id,
    });
    expect(result.error?.message).toContain("cannot deactivate your own membership");
  });

  it("deactivating the sole qualifying administrator is rejected, and their membership is left untouched", async () => {
    const memberManager = await authenticatedClient(fixture.memberManager);
    const result = await memberManager.rpc("deactivate_workspace_member_authorized", {
      p_workspace_id: fixture.workspaceId, p_user_id: fixture.adminOne.id,
    });
    expect(result.error?.message).toContain("must retain a member able to manage members and roles");

    const { data: membershipRow } = await createSupabaseTestClient()
      .from("workspace_memberships").select("deactivated_at")
      .eq("workspace_id", fixture.workspaceId).eq("user_id", fixture.adminOne.id).single();
    expect(membershipRow?.deactivated_at).toBeNull();
  });

  it("deactivates and reactivates a plain member, excluding them from workspace access while deactivated", async () => {
    const target = await createUser("deactivate-target");
    await addMembership(fixture.workspaceId, target.id, fixture.plainMemberRoleId);
    const targetClient = await authenticatedClient(target);

    // list_workspace_member_identities_authorized needs only
    // is_workspace_member (no specific capability) -- the real access
    // boundary this migration enforces. The raw workspace_memberships_
    // select_own RLS policy deliberately still lets a user see their own
    // row regardless of deactivation, so that would not prove anything.
    const beforeDeactivation = await targetClient.rpc("list_workspace_member_identities_authorized", {
      p_workspace_id: fixture.workspaceId,
    });
    expect(beforeDeactivation.error).toBeNull();

    const admin = await authenticatedClient(fixture.adminOne);
    const deactivate = await admin.rpc("deactivate_workspace_member_authorized", {
      p_workspace_id: fixture.workspaceId, p_user_id: target.id,
    });
    expect(deactivate.error).toBeNull();

    const afterDeactivation = await targetClient.rpc("list_workspace_member_identities_authorized", {
      p_workspace_id: fixture.workspaceId,
    });
    expect(afterDeactivation.error?.message).toContain("Workspace access denied");

    const memberList = await admin.rpc("list_workspace_member_identities_authorized", { p_workspace_id: fixture.workspaceId });
    expect((memberList.data as Array<{ user_id: string }>).map((row) => row.user_id)).not.toContain(target.id);

    const reactivate = await admin.rpc("reactivate_workspace_member_authorized", {
      p_workspace_id: fixture.workspaceId, p_user_id: target.id,
    });
    expect(reactivate.error).toBeNull();

    const afterReactivation = await targetClient.rpc("list_workspace_member_identities_authorized", {
      p_workspace_id: fixture.workspaceId,
    });
    expect(afterReactivation.error).toBeNull();
  });

  it("rejects deactivating an already-deactivated member and reactivating an already-active one", async () => {
    const target = await createUser("double-toggle-target");
    await addMembership(fixture.workspaceId, target.id, fixture.plainMemberRoleId);
    const admin = await authenticatedClient(fixture.adminOne);

    const alreadyActive = await admin.rpc("reactivate_workspace_member_authorized", {
      p_workspace_id: fixture.workspaceId, p_user_id: target.id,
    });
    expect(alreadyActive.error?.message).toContain("already active");

    const deactivate = await admin.rpc("deactivate_workspace_member_authorized", {
      p_workspace_id: fixture.workspaceId, p_user_id: target.id,
    });
    expect(deactivate.error).toBeNull();

    const alreadyDeactivated = await admin.rpc("deactivate_workspace_member_authorized", {
      p_workspace_id: fixture.workspaceId, p_user_id: target.id,
    });
    expect(alreadyDeactivated.error?.message).toContain("already deactivated");
  });
});
