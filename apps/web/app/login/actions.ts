"use server";

import { AuthError } from "next-auth";
import { signIn } from "../../auth";

export async function authenticate(_prevState: string | undefined, formData: FormData) {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/",
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
