"use client";

import { useActionState } from "react";
import { authenticate } from "./actions";

export default function LoginPage() {
  const [errorMessage, formAction, isPending] = useActionState(authenticate, undefined);

  return (
    <>
      <div className="ambient-field" aria-hidden />
      <main className="relative z-10 flex min-h-screen items-center justify-center px-6">
        <div className="panel w-full max-w-sm p-8">
          <div
            aria-hidden
            className="mb-5 h-9 w-9 rounded-full"
            style={{ background: "linear-gradient(135deg, var(--color-gold-400), var(--color-violet-400))" }}
          />
          <p className="eyebrow mb-1">Chris Content Intelligence</p>
          <h1 className="mb-6 text-xl font-semibold tracking-tight">Sign in</h1>

          <form action={formAction} className="flex flex-col gap-4">
            <label className="block text-sm">
              <span className="mb-1.5 block text-[var(--color-text-muted)]">Email</span>
              <input name="email" type="email" required className="field-input" autoComplete="email" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block text-[var(--color-text-muted)]">Password</span>
              <input
                name="password"
                type="password"
                required
                className="field-input"
                autoComplete="current-password"
              />
            </label>
            <button type="submit" disabled={isPending} className="btn btn-primary mt-1 w-full">
              {isPending ? "Signing in…" : "Sign in"}
            </button>
            {errorMessage && <p className="text-sm text-[var(--color-rose-400)]">{errorMessage}</p>}
          </form>
        </div>
      </main>
    </>
  );
}
