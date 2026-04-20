import { createBrowserClient } from "@supabase/ssr";
import { getSupabasePublicConfig } from "../public-env";

export function createClient() {
  const { key, url } = getSupabasePublicConfig();
  return createBrowserClient(url, key);
}
