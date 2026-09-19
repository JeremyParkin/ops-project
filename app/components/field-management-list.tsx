import type { ReactNode } from "react";
import {
  addChoiceOptionAction,
  archiveChoiceOptionAction,
  archiveField,
  deleteChoiceOptionAction,
  deleteField,
  moveChoiceOptionAction,
  moveFieldDefinition,
  restoreChoiceOptionAction,
  restoreField,
  updateChoiceOptionAction,
  updateFieldDefinition,
} from "@/app/actions";
import { ChoiceOptionManagement } from "@/app/components/choice-option-management";
import { FieldEditForm } from "@/app/components/field-edit-form";
import type { ChoiceOptionsByFieldId, FieldDefinition } from "@/lib/domain/types";

type FieldManagementListProps = {
  workspaceId: string;
  entityTypeId: string;
  fields: FieldDefinition[];
  entityNameById: Record<string, string>;
  workflowReferenceCountByFieldId: Record<string, number>;
  viewReferenceCountByFieldId?: Record<string, number>;
  choiceOptionsByFieldId?: ChoiceOptionsByFieldId;
  addFieldForm?: ReactNode;
};

export function FieldManagementList({
  workspaceId,
  entityTypeId,
  fields,
  entityNameById,
  workflowReferenceCountByFieldId,
  viewReferenceCountByFieldId = {},
  choiceOptionsByFieldId = {},
  addFieldForm,
}: FieldManagementListProps) {
  const orderedFields = [...fields].sort((left, right) => {
    return left.position - right.position;
  });

  return (
    <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-slate-950">Manage Fields</h2>
      </div>

      {addFieldForm ? (
        <details className="group mb-5 border border-brass/60 bg-brass/5 [&::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-l-4 border-brass px-4 py-2.5 text-sm font-semibold text-graphite hover:bg-brass/10">
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="text-base leading-none text-brass-deep">
                +
              </span>
              <span>Add field</span>
            </span>
            <span
              aria-hidden="true"
              className="shrink-0 text-sm text-slate-500 transition-transform group-open:rotate-90"
            >
              ▸
            </span>
          </summary>
          <div className="border-t border-brass/40 bg-white p-4">{addFieldForm}</div>
        </details>
      ) : null}

      <div className="divide-y divide-slate-100">
        {orderedFields.map((field, index) => {
          const updateFieldAction = updateFieldDefinition.bind(null, {
            workspaceId,
            entityTypeId,
            fieldDefinitionId: field.id,
          });
          const archiveFieldAction = archiveField.bind(null, {
            workspaceId,
            entityTypeId,
            fieldDefinitionId: field.id,
          });
          const restoreFieldAction = restoreField.bind(null, {
            workspaceId,
            entityTypeId,
            fieldDefinitionId: field.id,
          });
          const deleteFieldAction = deleteField.bind(null, {
            workspaceId,
            entityTypeId,
            fieldDefinitionId: field.id,
          });
          const moveFieldUpAction = moveFieldDefinition.bind(null, {
            workspaceId,
            entityTypeId,
            fieldDefinitionId: field.id,
            direction: "up",
          });
          const moveFieldDownAction = moveFieldDefinition.bind(null, {
            workspaceId,
            entityTypeId,
            fieldDefinitionId: field.id,
            direction: "down",
          });

          const choiceOptionManagement =
            field.type === "choice" ? (
              <ChoiceOptionManagement
                addOptionAction={addChoiceOptionAction.bind(null, {
                  workspaceId,
                  entityTypeId,
                  fieldDefinitionId: field.id,
                })}
                rows={(choiceOptionsByFieldId[field.id] ?? []).map((option) => ({
                  option,
                  updateAction: updateChoiceOptionAction.bind(null, {
                    workspaceId,
                    entityTypeId,
                    fieldDefinitionId: field.id,
                    optionId: option.id,
                  }),
                  archiveAction: option.archivedAt
                    ? undefined
                    : archiveChoiceOptionAction.bind(null, {
                        workspaceId,
                        entityTypeId,
                        fieldDefinitionId: field.id,
                        optionId: option.id,
                      }),
                  restoreAction: option.archivedAt
                    ? restoreChoiceOptionAction.bind(null, {
                        workspaceId,
                        entityTypeId,
                        fieldDefinitionId: field.id,
                        optionId: option.id,
                      })
                    : undefined,
                  deleteAction: option.archivedAt
                    ? deleteChoiceOptionAction.bind(null, {
                        workspaceId,
                        entityTypeId,
                        fieldDefinitionId: field.id,
                        optionId: option.id,
                      })
                    : undefined,
                  moveUpAction: option.archivedAt
                    ? undefined
                    : moveChoiceOptionAction.bind(null, {
                        workspaceId,
                        entityTypeId,
                        fieldDefinitionId: field.id,
                        optionId: option.id,
                        direction: "up",
                      }),
                  moveDownAction: option.archivedAt
                    ? undefined
                    : moveChoiceOptionAction.bind(null, {
                        workspaceId,
                        entityTypeId,
                        fieldDefinitionId: field.id,
                        optionId: option.id,
                        direction: "down",
                      }),
                }))}
              />
            ) : undefined;

          return (
            <div key={field.id} className="py-4 first:pt-0 last:pb-0">
              <FieldEditForm
                field={field}
                relatedEntityName={
                  field.relatedEntityTypeId
                    ? entityNameById[field.relatedEntityTypeId]
                    : undefined
                }
                choiceOptionManagement={choiceOptionManagement}
                updateFieldDefinitionAction={updateFieldAction}
                archiveFieldAction={archiveFieldAction}
                restoreFieldAction={restoreFieldAction}
                deleteFieldAction={deleteFieldAction}
                moveFieldUpAction={moveFieldUpAction}
                moveFieldDownAction={moveFieldDownAction}
                isFirst={index === 0}
                isLast={index === orderedFields.length - 1}
                workflowReferenceCount={
                  workflowReferenceCountByFieldId[field.id] ?? 0
                }
                viewReferenceCount={viewReferenceCountByFieldId[field.id] ?? 0}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
