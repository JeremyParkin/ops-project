"use client";

import {
  DiscussionSection,
  type DiscussionActionState,
  type DiscussionInputRequest,
} from "@/app/components/discussion-section";
import type {
  RecordInputRequest,
  RecordInputRequestRecipientCandidate,
} from "@/lib/domain/record-input-request-repository";
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
  inputRequests: RecordInputRequest[];
  inputRequestRecipientCandidates: RecordInputRequestRecipientCandidate[];
  currentUserId?: string;
  canCancelAnyInputRequest?: boolean;
  isArchivedRecord: boolean;
  createCommentAction: CommentAction;
  tombstoneCommentAction: CommentAction;
  createInputRequestAction: CommentAction;
  respondInputRequestAction: CommentAction;
  cancelInputRequestAction: CommentAction;
};

export function RecordDiscussion({
  comments,
  mentionCandidates,
  inputRequests,
  inputRequestRecipientCandidates,
  currentUserId,
  canCancelAnyInputRequest,
  isArchivedRecord,
  createCommentAction,
  tombstoneCommentAction,
  createInputRequestAction,
  respondInputRequestAction,
  cancelInputRequestAction,
}: RecordDiscussionProps) {
  const recipientCandidates = currentUserId
    ? inputRequestRecipientCandidates.filter((candidate) => candidate.userId !== currentUserId)
    : inputRequestRecipientCandidates;

  const discussionInputRequests: DiscussionInputRequest[] = inputRequests.map((request) => ({
    id: request.id,
    originCommentId: request.originRecordCommentId,
    recipientUserId: request.recipientUserId,
    recipientLabel: request.recipientLabel,
    responseCommentId: request.responseRecordCommentId,
    cancelledAt: request.cancelledAt,
    originAuthorUserId: request.originAuthorUserId,
    state: request.state,
  }));

  return (
    <DiscussionSection
      comments={comments}
      mentionCandidates={mentionCandidates}
      inputRequests={discussionInputRequests}
      inputRequestRecipientCandidates={recipientCandidates}
      currentUserId={currentUserId}
      canCancelAnyInputRequest={canCancelAnyInputRequest}
      composerUnavailableMessage={
        isArchivedRecord
          ? "Archived records are read-only. Existing discussion remains available."
          : undefined
      }
      createCommentAction={createCommentAction}
      tombstoneCommentAction={tombstoneCommentAction}
      createInputRequestAction={createInputRequestAction}
      respondInputRequestAction={respondInputRequestAction}
      cancelInputRequestAction={cancelInputRequestAction}
      inputIdPrefix="record"
    />
  );
}
