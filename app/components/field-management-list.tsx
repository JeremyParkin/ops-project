import {
  addChoiceOptionAction,
  archiveChoiceOptionAction,
  archiveField,
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
};

export function FieldManagementList({
  workspaceId,
  entityTypeId,
  fields,
  entityNameById,
  workflowReferenceCountByFieldId,
  viewReferenceCountByFieldId = {},
  choiceOptionsByFieldId = {},
}: FieldManagementListProps) {
  const orderedFields = [...fields].sort((left, right) => {
    return left.position - right.position;
  });

  return (
    <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-slate-950">Manage Fields</h2>
      </div>

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
