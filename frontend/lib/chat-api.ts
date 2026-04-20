import { createClient } from "./supabase/client";
import type { AgentActionResponse, WorkoutLogResponse } from "./api";
import type { CoachAPIResponse } from "./coach-api";
import { getApiBaseUrl } from "./public-env";

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

export interface ChatRequest {
  text: string;
  image_base64?: string;
  /** Pass the value from a previous coach turn to continue that conversation. */
  coach_conversation_id?: string | null;
  /** Pass the value from a previous pacer turn to continue that session. */
  pacer_conversation_id?: string | null;
}

export interface PlanItem {
  name: string;
  target_sets: number;
  target_reps: number;
  sets_done: number;
  finalized: boolean;
}

export interface PacerAPIResponse {
  conversation_id: string;
  turn_number: number;
  max_turns: number;
  message: string;
  phase: "planning" | "active" | "resting" | "done";
  rest_seconds: number | null;
  current_exercise: string | null;
  set_number: number | null;
  suggested_exercises: string[];
  logged_workout: WorkoutLogResponse | null;
  // Session progress
  total_exercises: number;
  completed_exercises: number;
  current_exercise_sets_done: number;
  current_exercise_sets_total: number;
  session_type: string | null;
  current_plan: PlanItem[];
  tts_audio_b64?: string;
}

export interface ChatResponse {
  agent_type: "workout" | "coach" | "pacer";
  workout: AgentActionResponse | null;
  coach: CoachAPIResponse | null;
  pacer: PacerAPIResponse | null;
  tts_audio_b64?: string;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function getToken(): Promise<string> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error("Not authenticated");
  return data.session.access_token;
}

interface APIEnvelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

async function chatFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...init,
  });

  let json: APIEnvelope<T>;
  try {
    json = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}: non-JSON response from server`);
  }

  if (!response.ok || !json.success) {
    throw new Error(json.error ?? `HTTP ${response.status}`);
  }
  if (json.data == null) throw new Error("No data returned from server");
  return json.data;
}

// ---------------------------------------------------------------------------
// Exported function
// ---------------------------------------------------------------------------

export async function sendChat(req: ChatRequest): Promise<ChatResponse> {
  return chatFetch<ChatResponse>("/api/v1/chat", {
    method: "POST",
    body: JSON.stringify(req),
  });
}
