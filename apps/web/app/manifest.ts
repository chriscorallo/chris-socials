import type { MetadataRoute } from "next";

// Web app manifest — makes "Add to Home Screen" (and Android's install prompt) launch a
// standalone, full-screen app with the dark theme instead of a browser tab.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Chris Studio",
    short_name: "Chris Studio",
    description: "Chris Content Intelligence System",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#050506",
    theme_color: "#050506",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
