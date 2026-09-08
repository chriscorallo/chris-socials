import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma, verifyPassword } from "@chris/domain";

/**
 * Auth.js v5, Credentials provider, single seeded User (Chris). Per /docs/DECISIONS.md —
 * this is a single-operator internal tool, not multi-tenant SaaS, so this is the least
 * infrastructure that satisfies Phase 0's "auth" requirement. Credentials providers require
 * the JWT session strategy (Auth.js does not support database sessions with Credentials) —
 * no adapter needed.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string") return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.userId = user.id;
      return token;
    },
    session({ session, token }) {
      if (session.user && typeof token.userId === "string") {
        session.user.id = token.userId;
      }
      return session;
    },
  },
});
