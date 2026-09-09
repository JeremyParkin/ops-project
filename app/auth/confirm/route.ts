import { NextResponse } from "next/server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { markRecoverySessionEstablished } from "@/lib/auth/password-recovery";

// Password recovery only -- this route does not accept generic OAuth/PKCE
// `code` callbacks. A verified session's JWT `amr` records only a broad
// "otp" method regardless of whether the link was recovery, magic-link, or
// signup confirmation (confirmed by inspecting a real verified session's
// claims), so an ambiguous successful exchange cannot be trusted to prove
// "this was a password-recovery event." The only way to make that proof
// honestly is to require the request itself to declare `type=recovery`
// *before* calling verifyOtp, and to only ever mark a recovery session once
// that specific verification has succeeded. Every other type, or a bare
// `code` param, is rejected outright without attempting any verification --
// if the dashboard's email template ever emits a different link shape,
// that's a Supabase configuration fix, not a reason to widen this route.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const resetPasswordUrl = new URL("/reset-password", request.url);

  if (tokenHash && type === "recovery") {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
    if (!error) {
      await markRecoverySessionEstablished();
      return NextResponse.redirect(resetPasswordUrl);
    }
  }

  // Missing/wrong type, or verification failed (expired/reused/invalid
  // link): redirect to /reset-password anyway -- it independently checks
  // for a genuine recovery session and shows its own invalid-link state
  // when there isn't one, so there's no need for a second, query-param-based
  // error signal.
  return NextResponse.redirect(resetPasswordUrl);
}
