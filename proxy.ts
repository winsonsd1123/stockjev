import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SITE_COOKIE, sessionMatches, sitePassword } from "@/lib/site-auth";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/_next")) return NextResponse.next();
  if (pathname === "/login" || pathname === "/api/auth") return NextResponse.next();

  const ok = sessionMatches(request.cookies.get(SITE_COOKIE)?.value, sitePassword());
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url, 302);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
