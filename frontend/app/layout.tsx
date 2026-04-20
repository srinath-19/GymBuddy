import type { Metadata } from "next";
import type { ReactNode } from "react";
import NavBar from "@/components/NavBar";
import { serializePublicEnvForScript } from "@/lib/public-env";
import { BGPattern } from "@/components/ui/bg-pattern";
import "./globals.css";

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
      <body className="relative">
        <BGPattern
          variant="diagonal-stripes"
          mask="none"
          size={28}
          fill="rgba(139, 92, 246, 0.07)"
          className="fixed"
        />
        <script dangerouslySetInnerHTML={{ __html: publicEnvScript }} />
        <NavBar />
        {children}
      </body>
    </html>
  );
}
