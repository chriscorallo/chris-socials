"use client";

import { useActionState } from "react";
import { authenticate } from "./actions";

export default function LoginPage() {
  const [errorMessage, formAction, isPending] = useActionState(authenticate, undefined);

  return (
    <>
      <div className="ambient-field" aria-hidden />
      <main
        className="relative z-10 flex min-h-dvh items-center justify-center px-5"
        style={{ paddingTop: "calc(var(--safe-top) + 1.5rem)", paddingBottom: "calc(var(--safe-bottom) + 1.5rem)" }}
      >
        <div className="panel w-full max-w-sm p-6 sm:p-8">
          <div
            aria-hidden
            className="mb-5 h-9 w-9 rounded-full"
            style={{ background: "linear-gradient(135deg, var(--color-gold-400), var(--color-violet-400))" }}
          />
          <p className="eyebrow mb-1">Chris Studio</p>
          <h1 className="mb-6 text-[26px] font-semibold tracking-tight sm:text-xl">Sign in</h1>

          <form action={formAction} className="flex flex-col gap-4">
            <label className="block text-sm">
              <span className="field-label">Email</span>
              <input
                name="email"
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                required
                className="field-input"
              />
            </label>
            <label className="block text-sm">
              <span className="field-label">Password</span>
              <input
                name="password"
                type="password"
                required
                className="field-input"
                autoComplete="current-password"
                enterKeyHint="go"
              />
            </label>
            <button type="submit" disabled={isPending} className="btn btn-primary mt-1 w-full !min-h-[50px] text-[16px]">
              {isPending ? "Signing in…" : "Sign in"}
            </button>
            {errorMessage && <p className="text-sm text-[var(--color-rose-400)]">{errorMessage}</p>}
          </form>
        </div>
      </main>
    </>
  );
}
