"use client";

import { ExerciseCoachResponse } from "@/lib/coach-api";
import YouTubeEmbed from "./YouTubeEmbed";

interface CoachResponseProps {
  response: ExerciseCoachResponse;
  onLogExercise: (name: string) => void;
}

const difficultyColor: Record<string, { bg: string; text: string; border: string }> = {
  beginner:     { bg: "#dcfce7", text: "#166534", border: "#bbf7d0" },
  intermediate: { bg: "#fef9c3", text: "#713f12", border: "#fde047" },
  advanced:     { bg: "#fee2e2", text: "#991b1b", border: "#fca5a5" },
};

export default function CoachResponse({ response, onLogExercise }: CoachResponseProps) {
  const {
    equipment_name,
    exercise_name,
    instructions,
    muscles_targeted,
    common_mistakes,
    difficulty,
    tips,
    videos,
    message,
  } = response;

  const diffStyle = difficulty ? difficultyColor[difficulty.toLowerCase()] : null;
  const primaryMuscles = muscles_targeted.filter((m) => m.role === "primary");
  const secondaryMuscles = muscles_targeted.filter((m) => m.role === "secondary");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <div>
          {equipment_name && (
            <p style={{ margin: 0, fontSize: "0.75rem", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {equipment_name}
            </p>
          )}
          {exercise_name && (
            <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "#111827" }}>
              {exercise_name}
            </h3>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          {diffStyle && difficulty && (
            <span style={{
              fontSize: "0.7rem", fontWeight: 600, padding: "0.15rem 0.55rem",
              borderRadius: "9999px", border: `1px solid ${diffStyle.border}`,
              backgroundColor: diffStyle.bg, color: diffStyle.text,
              textTransform: "capitalize",
            }}>
              {difficulty}
            </span>
          )}
          {exercise_name && (
            <button
              onClick={() => onLogExercise(exercise_name.toLowerCase())}
              style={{
                fontSize: "0.75rem", fontWeight: 600,
                padding: "0.2rem 0.65rem",
                backgroundColor: "#111827", color: "white",
                border: "none", borderRadius: "0.375rem", cursor: "pointer",
              }}
            >
              Log This Exercise
            </button>
          )}
        </div>
      </div>

      {/* Message */}
      <p style={{ margin: 0, fontSize: "0.875rem", color: "#374151", lineHeight: 1.6 }}>
        {message}
      </p>

      {/* Muscles */}
      {muscles_targeted.length > 0 && (
        <div>
          <p style={{ margin: "0 0 0.3rem", fontSize: "0.75rem", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Muscles
          </p>
          <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
            {primaryMuscles.map((m) => (
              <span key={m.muscle_group} style={{
                fontSize: "0.7rem", backgroundColor: "#dcfce7", color: "#166534",
                padding: "0.1rem 0.45rem", borderRadius: "9999px", border: "1px solid #bbf7d0",
              }}>{m.muscle_group}</span>
            ))}
            {secondaryMuscles.map((m) => (
              <span key={m.muscle_group} style={{
                fontSize: "0.7rem", backgroundColor: "#f1f5f9", color: "#475569",
                padding: "0.1rem 0.45rem", borderRadius: "9999px", border: "1px solid #e2e8f0",
              }}>{m.muscle_group}</span>
            ))}
          </div>
        </div>
      )}

      {/* Instructions */}
      {instructions.length > 0 && (
        <div>
          <p style={{ margin: "0 0 0.4rem", fontSize: "0.75rem", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            How To
          </p>
          <ol style={{ margin: 0, paddingLeft: "1.25rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {instructions.map((step, i) => (
              <li key={i} style={{ fontSize: "0.875rem", color: "#374151", lineHeight: 1.5 }}>
                {step}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* YouTube videos */}
      {videos.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {videos.map((v) => (
            <div key={v.video_id}>
              <p style={{ margin: "0 0 0.3rem", fontSize: "0.8rem", fontWeight: 500, color: "#374151" }}>{v.title}</p>
              <YouTubeEmbed videoId={v.video_id} title={v.title} />
            </div>
          ))}
        </div>
      )}

      {/* Common mistakes */}
      {common_mistakes.length > 0 && (
        <div>
          <p style={{ margin: "0 0 0.4rem", fontSize: "0.75rem", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Common Mistakes
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {common_mistakes.map((m, i) => (
              <li key={i} style={{ fontSize: "0.875rem", color: "#374151", lineHeight: 1.5 }}>
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tips */}
      {tips.length > 0 && (
        <div style={{
          padding: "0.6rem 0.75rem",
          backgroundColor: "#eff6ff",
          border: "1px solid #bfdbfe",
          borderRadius: "0.375rem",
        }}>
          {tips.map((tip, i) => (
            <p key={i} style={{ margin: i === 0 ? 0 : "0.25rem 0 0", fontSize: "0.8rem", color: "#1e40af", lineHeight: 1.5 }}>
              {tip}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
