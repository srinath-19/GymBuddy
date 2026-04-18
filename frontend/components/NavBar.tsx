"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function NavBar() {
  const path = usePathname();

  const linkStyle = (href: string): React.CSSProperties => ({
    fontSize: "0.875rem",
    fontWeight: 600,
    color: path === href ? "#111827" : "#9ca3af",
    textDecoration: "none",
    padding: "0.25rem 0",
    borderBottom: path === href ? "2px solid #111827" : "2px solid transparent",
    transition: "color 0.15s, border-color 0.15s",
  });

  return (
    <nav style={{
      position: "sticky",
      top: 0,
      zIndex: 50,
      backgroundColor: "white",
      borderBottom: "1px solid #e5e7eb",
    }}>
      <div style={{
        maxWidth: "720px",
        margin: "0 auto",
        padding: "0 1rem",
        height: "3rem",
        display: "flex",
        alignItems: "center",
        gap: "1.5rem",
      }}>
        <Link href="/" style={linkStyle("/")}>Workouts</Link>
        <Link href="/coach" style={linkStyle("/coach")}>Coach</Link>
        <Link href="/pacer" style={linkStyle("/pacer")}>Pacer</Link>
      </div>
    </nav>
  );
}
