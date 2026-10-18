import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

// Short name everywhere the OS shows it (home screen label, app switcher). Full product name
// stays in the description. See /docs/decisions-pending/mobile-app.md.
const APP_NAME = "Chris Studio";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: "Chris Content Intelligence System — a premium AI creative organization in software.",
  applicationName: APP_NAME,
  // "Add to Home Screen" on iOS: launches full-screen (no Safari chrome) with the content
  // drawn under a translucent status bar — every sticky header/bar pads itself with
  // env(safe-area-inset-*) to stay clear of the notch / Dynamic Island / home indicator.
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false, email: false, address: false },
};

// Next 16: viewport/themeColor live in their own export, not in `metadata`.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // "cover" lets the dark UI extend edge-to-edge; safe-area padding is handled in CSS.
  viewportFit: "cover",
  themeColor: "#050506",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // data-scroll-behavior="smooth": globals.css sets `scroll-behavior: smooth` (for in-page
    // anchors like #upload); this tells Next 16 to switch it off during route navigations, so a
    // tab tap from a scrolled page jumps to the top instead of animating the scroll.
    <html lang="en" className={inter.variable} data-scroll-behavior="smooth">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
