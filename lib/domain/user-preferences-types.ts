export type UserTheme = "system" | "light" | "dark";

export type UserPreferences = {
  theme: UserTheme;
  timezone: string | null;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  theme: "system",
  timezone: null,
};
