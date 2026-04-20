const PUBLIC_ENV_KEYS = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
] as const;

type PublicEnvKey = (typeof PUBLIC_ENV_KEYS)[number];
type PublicEnv = Partial<Record<PublicEnvKey, string>>;

declare global {
  interface Window {
    __GYMBUDDY_PUBLIC_ENV__?: PublicEnv;
  }
}

function getClientPublicEnv(): PublicEnv {
  if (typeof window === "undefined") {
    return {};
  }
  return window.__GYMBUDDY_PUBLIC_ENV__ ?? {};
}

export function getPublicEnv(name: PublicEnvKey): string | undefined {
  const clientValue = getClientPublicEnv()[name]?.trim();
  if (clientValue) {
    return clientValue;
  }

  const serverValue = process.env[name]?.trim();
  if (serverValue) {
    return serverValue;
  }

  return undefined;
}

export function getRequiredPublicEnv(name: PublicEnvKey): string {
  const value = getPublicEnv(name);
  if (!value) {
    throw new Error(`Missing public environment variable: ${name}`);
  }
  return value;
}

export function getApiBaseUrl(): string {
  return getPublicEnv("NEXT_PUBLIC_API_URL") ?? "http://localhost:8000";
}

export function getSupabasePublicConfig(): { key: string; url: string } {
  const url = getRequiredPublicEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key =
    getPublicEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") ??
    getPublicEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  if (!key) {
    throw new Error(
      "Missing public environment variable: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY"
    );
  }

  return { key, url };
}

export function serializePublicEnvForScript(): string {
  const publicEnv: PublicEnv = {};

  for (const key of PUBLIC_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) {
      publicEnv[key] = value;
    }
  }

  return JSON.stringify(publicEnv).replace(/</g, "\\u003c");
}
