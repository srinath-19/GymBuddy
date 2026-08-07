import { createClient } from "./supabase/client";
import { getApiBaseUrl } from "./public-env";

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

// Keyword fallback: split session type by spaces/symbols and match known muscle words.
// Handles ad-hoc names like "back biceps", "chest shoulders triceps", etc.
const MUSCLE_KEYWORDS: Record<string, string> = {
  chest: "chest",
  shoulder: "shoulders", shoulders: "shoulders", delt: "shoulders", delts: "shoulders",
  tricep: "triceps", triceps: "triceps",
  back: "back", lat: "back", lats: "back",
  bicep: "biceps", biceps: "biceps",
  trap: "traps", traps: "traps",
  quad: "quads", quads: "quads",
  hamstring: "hamstrings", hamstrings: "hamstrings",
  glute: "glutes", glutes: "glutes",
  calf: "calves", calves: "calves",
  core: "core", abs: "core",
};

function extractMusclesFromLabel(sessionType: string): string[] {
  const words = sessionType.trim().toLowerCase().split(/[\s,&+/]+/);
  const found = new Set<string>();
  for (const word of words) {
    const muscle = MUSCLE_KEYWORDS[word];
    if (muscle) found.add(muscle);
  }
  return [...found];
}

export function getExpectedMuscles(sessionType: string): string[] {
  const key = sessionType.trim().toLowerCase();
  return SESSION_MUSCLE_MAP[key] ?? extractMusclesFromLabel(sessionType);
}

// Required muscles for completion — excludes secondary muscles that are naturally
// worked (e.g. triceps on push day). A session is "complete" when all required
// muscles are covered, regardless of secondary/bonus muscles.
export const SESSION_REQUIRED_MUSCLES: Record<string, string[]> = {
  push:                   ["chest", "shoulders", "triceps"],
  pull:                   ["back", "biceps"],
  legs:                   ["quads", "hamstrings", "glutes"],
  lower:                  ["quads", "hamstrings", "glutes"],
  chest:                  ["chest"],
  "chest day":            ["chest"],
  "chest and triceps":    ["chest", "triceps"],
  back:                   ["back"],
  "back day":             ["back"],
  "back and biceps":      ["back", "biceps"],
  "back and bis":         ["back", "biceps"],
  shoulders:              ["shoulders"],
  "shoulder day":         ["shoulders"],
  delts:                  ["shoulders"],
  arms:                   ["biceps", "triceps"],
  "arm day":              ["biceps", "triceps"],
  "bis and tris":         ["biceps", "triceps"],
  upper:                  ["chest", "back", "shoulders"],
  "upper body":           ["chest", "back", "shoulders"],
  "full body":            ["chest", "back", "shoulders", "quads", "hamstrings"],
  full:                   ["chest", "back", "shoulders", "quads", "hamstrings"],
  core:                   ["core"],
  abs:                    ["core"],
  "ab day":               ["core"],
};

export function getRequiredMuscles(sessionType: string): string[] {
  const key = sessionType.trim().toLowerCase();
  return SESSION_REQUIRED_MUSCLES[key] ?? SESSION_MUSCLE_MAP[key] ?? extractMusclesFromLabel(sessionType);
}

export interface AgentActionResponse {
  action: "logged" | "deleted" | "found" | "updated" | "none" | "session_started";
  message: string;
  workout: WorkoutLogResponse | null;
  workouts: WorkoutLogResponse[] | null;
  session: WorkoutSession | null;
  tts_audio_b64?: string;
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
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
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

/** The browser's IANA timezone — the backend needs it to resolve calendar dates. */
export function clientTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Transcribes a recorded audio clip server-side.
 *
 * Used instead of the browser Web Speech API on phones, whose platform
 * recognizers return duplicated and truncated transcripts. See
 * `backend/app/routes/transcribe.py`.
 */
export async function transcribeAudio(
  audio: Blob,
  filename: string
): Promise<string> {
  const token = await getToken();
  const form = new FormData();
  form.append("file", audio, filename);

  const response = await fetch(`${getApiBaseUrl()}/api/v1/transcribe`, {
    method: "POST",
    // Content-Type is deliberately unset — the browser has to add the multipart
    // boundary itself, and setting it manually corrupts the request body.
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  let json: (APIResponse<{ text: string }> & { detail?: string }) | null = null;
  try {
    json = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}: non-JSON response from server`);
  }

  if (!response.ok || !json?.success) {
    // FastAPI's HTTPException returns { detail } rather than the usual envelope.
    throw new Error(json?.error ?? json?.detail ?? `HTTP ${response.status}`);
  }
  return json.data?.text?.trim() ?? "";
}

export async function logWorkout(
  transcript: string
): Promise<AgentActionResponse> {
  const result = await apiFetch<AgentActionResponse>("/api/v1/workouts", {
    method: "POST",
    body: JSON.stringify({ transcript, client_tz: clientTz() }),
  });
  if (!result.data) throw new Error("No data returned from server");
  return result.data;
}

type WorkoutStreamEvent =
  | { type: "progress"; message: string }
  | { type: "done"; data: AgentActionResponse }
  | { type: "error"; message: string };

export async function logWorkoutStreamed(
  transcript: string,
  onProgress: (message: string) => void,
): Promise<AgentActionResponse> {
  const token = await getToken();

  const response = await fetch(`${getApiBaseUrl()}/api/v1/workouts/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ transcript, client_tz: clientTz() }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(err?.error ?? `HTTP ${response.status}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: AgentActionResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as WorkoutStreamEvent;
      if (event.type === "progress") {
        onProgress(event.message);
      } else if (event.type === "done") {
        finalResult = event.data;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
  }

  if (!finalResult) throw new Error("Stream ended without a result");
  return finalResult;
}

export async function getWorkouts(limit = 50): Promise<WorkoutLogResponse[]> {
  const result = await apiFetch<WorkoutLogResponse[]>(`/api/v1/workouts?limit=${limit}`);
  return result.data ?? [];
}

export interface ManualWorkoutRequest {
  exercise: string;
  sets: number;
  reps: number;
  weight: number;
  weight_unit: "lbs" | "kg";
  notes?: string;
  logged_at?: string;   // "YYYY-MM-DD" — omit for now
  client_tz?: string;   // IANA zone that logged_at's calendar day is relative to
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

export async function getSessions(days = 90): Promise<WorkoutSession[]> {
  const result = await apiFetch<WorkoutSession[]>(
    `/api/v1/sessions?days=${days}&tz=${encodeURIComponent(clientTz())}`
  );
  return result.data ?? [];
}

export async function updateSession(
  date: string,
  sessionType: string,
  notes?: string,
): Promise<WorkoutSession> {
  const result = await apiFetch<WorkoutSession>(`/api/v1/sessions/${date}`, {
    method: "PUT",
    body: JSON.stringify({ session_type: sessionType, notes: notes ?? null }),
  });
  if (!result.data) throw new Error("No data returned from server");
  return result.data;
}
