import { NextResponse } from "next/server";
import {
  SITE_COOKIE,
  passwordMatches,
  sessionCookieOptions,
  sessionToken,
  sitePassword,
} from "@/lib/site-auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = sitePassword();
  if (!secret) {
    return NextResponse.json({ error: "未配置口令" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as { password?: unknown };
  const password = typeof body.password === "string" ? body.password : "";
  if (!passwordMatches(password, secret)) {
    return NextResponse.json({ error: "口令错误" }, { status: 401 });
  }

  const token = sessionToken(secret);
  if (!token) {
    return NextResponse.json({ error: "未配置口令" }, { status: 503 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SITE_COOKIE, token, sessionCookieOptions());
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SITE_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
