"use server";

import { AuthError } from "next-auth";
import { signIn } from "../../auth";

/** Only a same-site path ("/oauth/authorize?…" when ChatGPT sent Chris here) — never another origin. */
function safeNext(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.includes("\\") && s.length < 4000 ? s : "/";
}

export async function authenticate(_prevState: string | undefined, formData: FormData) {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: safeNext(formData.get("next")),
    });
    return undefined;
  } catch (error) {
    if (error instanceof AuthError) {
      return "Invalid email or password.";
    }
    // NextAuth's redirect throws a special Next.js redirect signal — let it propagate.
    throw error;
  }
}
