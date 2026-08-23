"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { setActiveWorkspaceId } from "@/lib/auth/workspace";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function switchActiveWorkspace(formData: FormData) {
  const workspaceId = String(formData.get("workspaceId") ?? "");
  await setActiveWorkspaceId(workspaceId);
  revalidatePath("/", "layout");
  redirect("/");
}

export async function signOut() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}
