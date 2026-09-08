import { redirect } from "next/navigation";
import { auth } from "../auth";

/** Every page under the app shell calls this first. Keeps the "redirect to /login when
 * unauthenticated" check in one place instead of repeated per page. */
export async function requireSession() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  return session;
}
