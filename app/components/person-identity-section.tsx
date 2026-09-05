"use client";

import { useActionState, useState } from "react";
import type { RecordActionState } from "@/lib/domain/record-repository";
import { CollapsibleSection } from "@/app/components/page-primitives";
import type { WorkspaceMemberIdentity } from "@/lib/domain/process-types";

type PersonIdentitySectionProps = {
  linkedEmail?: string;
  canManageLinks: boolean;
  candidates: WorkspaceMemberIdentity[];
  linkPersonAction: (state: RecordActionState, formData: FormData) => Promise<RecordActionState>;
  unlinkPersonAction: (state: RecordActionState, formData: FormData) => Promise<RecordActionState>;
};

const initialState: RecordActionState = { success: false, message: "" };

// Phase 12.1: identity is visible to any workspace viewer of a Person-type
// record (the fact that a link exists is not itself sensitive), but only
// workspace.manage_members holders ever see the Link/Unlink controls --
// mirrors every other administrative-control pattern in this app.
export function PersonIdentitySection({
  linkedEmail,
  canManageLinks,
  candidates,
  linkPersonAction,
  unlinkPersonAction,
}: PersonIdentitySectionProps) {
  const [isLinking, setIsLinking] = useState(false);
  const [linkState, linkFormAction, linkPending] = useActionState(linkPersonAction, initialState);
  const [unlinkState, unlinkFormAction, unlinkPending] = useActionState(unlinkPersonAction, initialState);

  return (
    <CollapsibleSection title="Identity" description="This record's link to a workspace member login.">
      {linkedEmail ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-sm text-graphite">
            Linked to <span className="font-medium">{linkedEmail}</span>
          </p>
          {canManageLinks ? (
            <form action={unlinkFormAction}>
              <button
                type="submit"
                disabled={unlinkPending}
                className="inline-flex h-9 items-center justify-center border border-grit px-3 text-sm font-medium text-stone hover:border-graphite hover:text-graphite disabled:cursor-not-allowed"
              >
                {unlinkPending ? "Unlinking..." : "Unlink"}
              </button>
            </form>
          ) : null}
        </div>
      ) : (
        <div className="mt-2">
          <p className="text-sm text-stone">Not linked to a workspace member.</p>
          {canManageLinks ? (
            !isLinking ? (
              <button
                type="button"
                onClick={() => setIsLinking(true)}
                className="mt-2 inline-flex h-9 items-center justify-center border border-grit px-3 text-sm font-medium text-stone hover:border-graphite hover:text-graphite"
              >
                Link workspace member
              </button>
            ) : (
              <form action={linkFormAction} className="mt-2 flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-sm text-graphite">
                  Workspace member
                  <select
                    name="userId"
                    required
                    defaultValue=""
                    className="h-9 w-72 border border-grit bg-white px-2 text-sm text-graphite"
                  >
                    <option value="" disabled>
                      Choose a workspace member
                    </option>
                    {candidates.map((candidate) => (
                      <option key={candidate.userId} value={candidate.userId}>
                        {candidate.email}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  disabled={linkPending}
                  className="h-9 bg-brass px-3 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
                >
                  {linkPending ? "Linking..." : "Link"}
                </button>
                <button
                  type="button"
                  onClick={() => setIsLinking(false)}
                  disabled={linkPending}
                  className="h-9 px-3 text-sm font-medium text-stone hover:text-graphite"
                >
                  Never mind
                </button>
              </form>
            )
          ) : null}
        </div>
      )}
      {linkState.message ? (
        <p className={`mt-2 text-sm ${linkState.success ? "text-status-sage" : "text-red-700"}`}>
          {linkState.message}
        </p>
      ) : null}
      {unlinkState.message ? (
        <p className={`mt-2 text-sm ${unlinkState.success ? "text-status-sage" : "text-red-700"}`}>
          {unlinkState.message}
        </p>
      ) : null}
    </CollapsibleSection>
  );
}
