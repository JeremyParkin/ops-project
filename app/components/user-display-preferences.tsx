"use client";

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { UserPreferences } from "@/lib/domain/user-preferences-types";

const PreferencesContext = createContext<UserPreferences>({ theme: "system", timezone: null });

export function UserDisplayPreferences({ preferences, children }: { preferences: UserPreferences; children: ReactNode }) {
  return (
    <div className="theme-root contents" data-theme={preferences.theme}>
      <PreferencesContext.Provider value={preferences}>{children}</PreferencesContext.Provider>
    </div>
  );
}

export function useUserDisplayPreferences() {
  return useContext(PreferencesContext);
}

export function useHydrated() {
  return useSyncExternalStore(() => () => {}, () => true, () => false);
}
