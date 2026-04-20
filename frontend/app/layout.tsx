import type { Metadata } from "next";
import type { ReactNode } from "react";
import NavBar from "@/components/NavBar";
import { serializePublicEnvForScript } from "@/lib/public-env";

export const metadata: Metadata = {
  title: "GymBuddy",
  description: "Voice-first workout tracker",
};

// The deployed frontend needs to read Cloud Run runtime env vars on each
// request instead of baking NEXT_PUBLIC_* values into the build outputs.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  const publicEnvScript = `window.__GYMBUDDY_PUBLIC_ENV__ = ${serializePublicEnvForScript()};`;

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          backgroundColor: "#f9fafb",
          color: "#111827",
        }}
      >
        <script dangerouslySetInnerHTML={{ __html: publicEnvScript }} />
        <NavBar />
        {children}
      </body>
    </html>
  );
}
