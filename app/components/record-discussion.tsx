"use client";

import {
  DiscussionSection,
  type DiscussionActionState,
} from "@/app/components/discussion-section";
import type {
  RecordComment,
  RecordCommentMentionCandidate,
} from "@/lib/domain/record-comment-repository";

type CommentAction = (
  state: DiscussionActionState,
  formData: FormData,
) => Promise<DiscussionActionState>;

type RecordDiscussionProps = {
  comments: RecordComment[];
  mentionCandidates: RecordCommentMentionCandidate[];
  isArchivedRecord: boolean;
  createCommentAction: CommentAction;
  tombstoneCommentAction: CommentAction;
};

export function RecordDiscussion({
  comments,
  mentionCandidates,
  isArchivedRecord,
  createCommentAction,
  tombstoneCommentAction,
}: RecordDiscussionProps) {
  return (
    <DiscussionSection
      comments={comments}
      mentionCandidates={mentionCandidates}
      composerUnavailableMessage={
        isArchivedRecord
          ? "Archived records are read-only. Existing discussion remains available."
          : undefined
      }
      createCommentAction={createCommentAction}
      tombstoneCommentAction={tombstoneCommentAction}
      inputIdPrefix="record"
    />
  );
}
