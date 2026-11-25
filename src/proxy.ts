import { NextResponse } from "next/server";

import { auth } from "@/auth";

// Optimistic check: sends visitors without a valid session to the login page. The real check
// (active user, tenant, session version, permissions) happens in src/server/auth/session.ts.
//
// Running through `auth()` here also renews the session cookie on every page visit and action.
// Server components cannot set cookies, so without this the session ended a fixed time after
// login even while people were working.

const PUBLIC_PATHS = ["/login", "/api/auth"];

export default auth((request) => {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }
  if (!request.auth) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|ico)$).*)"],
};
