import { createBrowserClient } from "@supabase/ssr";

// New projects (created after Nov 2025) use PUBLISHABLE_KEY.
// Older projects use ANON_KEY. Support both.
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    supabaseKey
  );
}
