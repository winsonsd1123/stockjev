import { createHmac, timingSafeEqual } from "crypto";

export const SITE_COOKIE = "site_session";
const SESSION_LABEL = "site-session-v1";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

export function sitePassword(): string {
  return process.env.SITE_PASSWORD ?? "";
}

export function sessionToken(secret: string): string | null {
  if (!secret) return null;
  return createHmac("sha256", secret).update(SESSION_LABEL).digest("base64url");
}

export function sessionMatches(cookieValue: string | undefined, secret: string): boolean {
  const expected = sessionToken(secret);
  if (!expected || cookieValue == null || cookieValue === "") return false;
  const actual = Buffer.from(cookieValue);
  const want = Buffer.from(expected);
  if (actual.length !== want.length) return false;
  return timingSafeEqual(actual, want);
}

export function passwordMatches(input: string, secret: string): boolean {
  const given = sessionToken(input);
  if (!given) return false;
  return sessionMatches(given, secret);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  };
}
