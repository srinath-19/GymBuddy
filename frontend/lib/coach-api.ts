import { createClient } from "./supabase/client";
import { getApiBaseUrl } from "./public-env";

export interface CoachRequest {
  text: string;
  image_base64?: string;
  conversation_id?: string | null;
}

export interface VideoResult {
  video_id: string;
  title: string;
  thumbnail_url: string;
  url: string;
}

export interface CoachMuscleTarget {
  muscle_group: string;
  role: string; // "primary" | "secondary"
}

export interface ExerciseCoachResponse {
  equipment_name: string | null;
  exercise_name: string | null;
  instructions: string[];
  muscles_targeted: CoachMuscleTarget[];
  common_mistakes: string[];
  difficulty: string | null;
  tips: string[];
  videos: VideoResult[];
  message: string;
}

export interface CoachAPIResponse {
  conversation_id: string;
  turn_number: number;
  max_turns: number;
  response: ExerciseCoachResponse;
}

interface APIEnvelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

async function getToken(): Promise<string> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error("Not authenticated");
  return data.session.access_token;
}

async function coachFetch<T>(path: string, init?: RequestInit): Promise<T> {
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

export async function askCoach(req: CoachRequest): Promise<CoachAPIResponse> {
  return coachFetch<CoachAPIResponse>("/api/v1/coach/ask", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function clearConversation(conversationId: string): Promise<void> {
  const token = await getToken();
  await fetch(`${getApiBaseUrl()}/api/v1/coach/conversation/${conversationId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Resize an image to max 1024px on its longest side and return a base64 JPEG. */
export function resizeImageToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1024;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        if (width >= height) {
          height = Math.round((height * MAX) / width);
          width = MAX;
        } else {
          width = Math.round((width * MAX) / height);
          height = MAX;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = url;
  });
}
