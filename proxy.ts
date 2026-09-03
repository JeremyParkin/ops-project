import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) return response;

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const { data: claims } = await supabase.auth.getClaims();
  const pathname = request.nextUrl.pathname;
  // /accept-invitation must stay reachable both signed out (a brand-new
  // invitee has no session yet) and signed in (accepting a second
  // invitation, or the invited email already has an account) -- unlike
  // /sign-in, an authenticated visitor must not be bounced away from it.
  const isSignInRoute = pathname === "/sign-in";
  const isAcceptInvitationRoute = pathname === "/accept-invitation";

  if (!claims && !isSignInRoute && !isAcceptInvitationRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    return NextResponse.redirect(url);
  }

  if (claims && isSignInRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

// api/v1 (bearer API keys, 8F.3) and api/internal (bearer scheduler
// secrets, 8F.2/8F.3) both authenticate themselves entirely independently
// of a session cookie -- neither has one to check, by design, since their
// callers are external scripts/schedulers, not a signed-in browser. Without
// this exclusion, every request to either family was redirected to
// /sign-in by this proxy before its own route handler ever ran, found by
// making a real, unauthenticated HTTP call to /api/v1/objects rather than
// only testing these routes via direct in-process function calls.
//
// icon.svg/apple-icon.png/manifest.webmanifest are Next.js's app-icon file
// conventions (favicon.ico was already excluded here) -- a signed-out
// visitor's browser requests these directly, so without the same exclusion
// they'd get redirected to the /sign-in HTML page instead of the actual
// asset.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|branding|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|api/v1|api/internal).*)",
  ],
};
