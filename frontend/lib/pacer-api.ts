import { createClient } from "./supabase/client";
import type { PacerAPIResponse } from "./chat-api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ---------------------------------------------------------------------------
// Typed manual actions — emitted by WorkoutPacer buttons, handled by the page
// ---------------------------------------------------------------------------

export type PacerManualAction =
  | { type: "set-done"; reps?: number; weight?: number; weight_unit?: string }
  | { type: "skip" }
  | { type: "plan-remove"; exercise_name: string }
  | { type: "plan-add"; exercise_name: string; target_sets?: number; target_reps?: number }
  | { type: "plan-change"; exercise_name: string; target_sets?: number; target_reps?: number }
  | { type: "plan-swap"; exercise_name: string; replacement_name: string; target_sets?: number; target_reps?: number };

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function getToken(): Promise<string> {
  const { data } = await createClient().auth.getSession();
  if (!data.session?.access_token) throw new Error("Not authenticated");
  return data.session.access_token;
}

async function pacerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...init,
  });
  const json: { success: boolean; data: T | null; error: string | null } = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`);
  if (json.data == null) throw new Error("No data returned");
  return json.data;
}

// ---------------------------------------------------------------------------
// Direct pacer endpoints
// ---------------------------------------------------------------------------

export async function pacerSetDone(
  convId: string,
  opts: { reps?: number; weight?: number; weight_unit?: string } = {},
): Promise<PacerAPIResponse> {
  return pacerFetch(`/api/v1/pacer/${convId}/set-done`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export async function pacerSkip(convId: string): Promise<PacerAPIResponse> {
  return pacerFetch(`/api/v1/pacer/${convId}/skip`, { method: "POST", body: "{}" });
}

export async function pacerModifyPlan(
  convId: string,
  body: {
    action: "remove" | "add" | "swap" | "change";
    exercise_name: string;
    replacement_name?: string;
    target_sets?: number;
    target_reps?: number;
  },
): Promise<PacerAPIResponse> {
  return pacerFetch(`/api/v1/pacer/${convId}/plan`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
