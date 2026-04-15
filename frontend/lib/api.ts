import { createClient } from "./supabase/client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface WorkoutLogResponse {
  id: string;
  user_id: string | null;
  exercise: string;
  sets: number;
  reps: number;
  weight: number;
  weight_unit: "lbs" | "kg";
  notes: string | null;
  logged_at: string;
  created_at: string;
}

interface APIResponse<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

async function getToken(): Promise<string> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) {
    throw new Error("Not authenticated");
  }
  return data.session.access_token;
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<APIResponse<T>> {
  const token = await getToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...init,
  });

  let json: APIResponse<T>;
  try {
    json = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}: non-JSON response from server`);
  }

  if (!response.ok || !json.success) {
    throw new Error(json.error ?? `HTTP ${response.status}`);
  }
  return json;
}

export async function logWorkout(
  transcript: string
): Promise<WorkoutLogResponse> {
  const result = await apiFetch<WorkoutLogResponse>("/api/v1/workouts", {
    method: "POST",
    body: JSON.stringify({ transcript }),
  });
  if (!result.data) throw new Error("No data returned from server");
  return result.data;
}

export async function getWorkouts(): Promise<WorkoutLogResponse[]> {
  const result = await apiFetch<WorkoutLogResponse[]>("/api/v1/workouts");
  return result.data ?? [];
}
