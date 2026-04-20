"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export default function NavBar() {
  const path = usePathname();

  return (
    <nav className="glass-nav sticky top-0 z-50">
      <div className="max-w-3xl mx-auto px-4 h-12 flex items-center gap-6">
        {[
          { href: "/", label: "Workouts" },
          { href: "/coach", label: "Coach" },
          { href: "/pacer", label: "Pacer" },
        ].map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "text-sm font-semibold no-underline pb-0.5 border-b-2 transition-colors duration-150",
              path === href
                ? "text-white border-white"
                : "text-white/50 border-transparent hover:text-white/80"
            )}
          >
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
