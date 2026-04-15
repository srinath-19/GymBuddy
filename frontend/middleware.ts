import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    supabaseKey,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getClaims() verifies the JWT signature locally — never use getSession() in
  // server code as it reads the cookie without signature verification.
  const { data } = await supabase.auth.getClaims();
  const isAuthenticated = data?.claims != null;

  const { pathname } = request.nextUrl;
  const isLoginPage = pathname === "/login";

  // Unauthenticated user hitting a protected page → send to login
  if (!isAuthenticated && !isLoginPage) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Authenticated user hitting /login → send to app
  if (isAuthenticated && isLoginPage) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  // Run on all routes except Next.js internals and static files.
  // /login is included so the authenticated → "/" redirect works.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
