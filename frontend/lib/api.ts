import { createClient } from "./supabase/client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface MuscleTargetResponse {
  muscle_group: string;
  specific_muscles: string[];
  role: "primary" | "secondary";
  source: "lookup" | "ai_inferred";
}

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
  is_personal_record: boolean;
  muscle_targets: MuscleTargetResponse[];
}

export interface WorkoutSession {
  id: string;
  user_id: string;
  date: string;          // "YYYY-MM-DD"
  session_type: string;
  notes: string | null;
  created_at: string;
}

export const SESSION_MUSCLE_MAP: Record<string, string[]> = {
  push:              ["chest", "shoulders", "triceps"],
  pull:              ["back", "biceps"],
  legs:              ["quads", "hamstrings", "glutes", "calves"],
  lower:             ["quads", "hamstrings", "glutes", "calves"],
  chest:             ["chest", "triceps"],
  "chest day":       ["chest", "triceps"],
  "chest and triceps": ["chest", "triceps"],
  back:              ["back", "biceps"],
  "back day":        ["back", "biceps"],
  "back and biceps": ["back", "biceps"],
  "back and bis":    ["back", "biceps"],
  shoulders:         ["shoulders", "traps"],
  "shoulder day":    ["shoulders", "traps"],
  delts:             ["shoulders", "traps"],
  arms:              ["biceps", "triceps"],
  "arm day":         ["biceps", "triceps"],
  "bis and tris":    ["biceps", "triceps"],
  upper:             ["chest", "back", "shoulders", "biceps", "triceps"],
  "upper body":      ["chest", "back", "shoulders", "biceps", "triceps"],
  "full body":       ["chest", "back", "shoulders", "quads", "hamstrings", "glutes"],
  full:              ["chest", "back", "shoulders", "quads", "hamstrings", "glutes"],
  core:              ["core"],
  abs:               ["core"],
  "ab day":          ["core"],
};

export function getExpectedMuscles(sessionType: string): string[] {
  return SESSION_MUSCLE_MAP[sessionType.trim().toLowerCase()] ?? [];
}

export interface AgentActionResponse {
  action: "logged" | "deleted" | "found" | "updated" | "none" | "session_started";
  message: string;
  workout: WorkoutLogResponse | null;
  workouts: WorkoutLogResponse[] | null;
  session: WorkoutSession | null;
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
): Promise<AgentActionResponse> {
  const result = await apiFetch<AgentActionResponse>("/api/v1/workouts", {
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

export interface ManualWorkoutRequest {
  exercise: string;
  sets: number;
  reps: number;
  weight: number;
  weight_unit: "lbs" | "kg";
  notes?: string;
}

export interface WorkoutUpdateRequest {
  exercise?: string;
  sets?: number;
  reps?: number;
  weight?: number;
  weight_unit?: "lbs" | "kg";
  notes?: string;
}

export async function addWorkoutManually(
  data: ManualWorkoutRequest
): Promise<WorkoutLogResponse> {
  const result = await apiFetch<WorkoutLogResponse>("/api/v1/workouts/manual", {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!result.data) throw new Error("No data returned from server");
  return result.data;
}

export async function updateWorkout(
  id: string,
  data: WorkoutUpdateRequest
): Promise<WorkoutLogResponse> {
  const result = await apiFetch<WorkoutLogResponse>(`/api/v1/workouts/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
  if (!result.data) throw new Error("No data returned from server");
  return result.data;
}

export async function deleteWorkout(id: string): Promise<void> {
  await apiFetch<WorkoutLogResponse>(`/api/v1/workouts/${id}`, {
    method: "DELETE",
  });
}

export async function getSessions(days = 7): Promise<WorkoutSession[]> {
  const result = await apiFetch<WorkoutSession[]>(`/api/v1/sessions?days=${days}`);
  return result.data ?? [];
}
