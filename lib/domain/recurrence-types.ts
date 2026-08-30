import type { IsoUtcTimestamp } from "./types";

export type RecurrenceFrequency = "daily" | "weekly" | "monthly";

export type ProcessRecurrenceRule = {
  id: string;
  workspaceId: string;
  processTemplateId: string;
  originEntityTypeId: string;
  originRecordId: string;
  frequency: RecurrenceFrequency;
  intervalCount: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  startDate: string;
  endDate?: string;
  timeOfDay: string;
  active: boolean;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};

export type ProcessRecurrenceRuleInput = {
  frequency: RecurrenceFrequency;
  intervalCount: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  startDate: string;
  endDate?: string;
  timeOfDay: string;
};
