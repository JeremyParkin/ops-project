export type UserIdentityLabelSource = {
  email: string;
  displayName?: string | null;
};

export function primaryUserLabel(identity: UserIdentityLabelSource) {
  return identity.displayName?.trim() || identity.email;
}

export function pickerUserLabel(identity: UserIdentityLabelSource) {
  const displayName = identity.displayName?.trim();
  return displayName ? `${displayName} — ${identity.email}` : identity.email;
}

export function deactivatedUserLabel(identity: UserIdentityLabelSource) {
  return `${primaryUserLabel(identity)} (Deactivated)`;
}
