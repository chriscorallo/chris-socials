"use client";

import { useRef, useState } from "react";

/** A read-only value with a big "Copy" button (Clipboard API, select-and-copy fallback for iOS). */
export function CopyField({ value, label, button, multiline = false }: { value: string; label: string; button: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const el = ref.current;
      if (el) {
        el.focus();
        el.select();
        el.setSelectionRange(0, value.length);
        document.execCommand("copy");
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const common = {
    readOnly: true,
    value,
    "aria-label": label,
    className: "field-input w-full min-w-0 font-mono text-[14px]",
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => e.currentTarget.select(),
  };

  return (
    <div className="flex flex-col gap-2">
      {multiline ? <textarea ref={ref} rows={4} {...common} className={`${common.className} !font-sans leading-snug`} /> : <input ref={ref} {...common} />}
      <button type="button" onClick={copy} className="btn btn-primary w-full !min-h-[46px]">
        {copied ? "Copied ✓" : button}
      </button>
    </div>
  );
}
