"use client";

import { useEffect, useRef, useState } from "react";
import type { PacerAPIResponse } from "@/lib/chat-api";
import type { MuscleTargetResponse } from "@/lib/api";

interface WorkoutPacerProps {
  response: PacerAPIResponse;
}

const phaseColors: Record<string, { bg: string; text: string; border: string; label: string }> = {
  planning: { bg: "#eff6ff", text: "#1d4ed8", border: "#bfdbfe", label: "Planning" },
  active:   { bg: "#f0fdf4", text: "#15803d", border: "#bbf7d0", label: "Active"   },
  resting:  { bg: "#fefce8", text: "#a16207", border: "#fde68a", label: "Resting"  },
  done:     { bg: "#f3f4f6", text: "#374151", border: "#d1d5db", label: "Done"     },
};

export default function WorkoutPacer({ response }: WorkoutPacerProps) {
  const {
    message,
    phase,
    rest_seconds,
    current_exercise,
    set_number,
    suggested_exercises,
    logged_workout,
  } = response;

  const phaseStyle = phaseColors[phase] ?? phaseColors.planning;

  // ---------------------------------------------------------------------------
  // Rest countdown timer
  // ---------------------------------------------------------------------------
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  // Track which rest period we're timing so a new response resets the clock
  const restKeyRef = useRef<number>(0);

  useEffect(() => {
    if (phase === "resting" && rest_seconds && rest_seconds > 0) {
      restKeyRef.current += 1;
      setTimeLeft(rest_seconds);
    } else {
      setTimeLeft(null);
    }
  }, [phase, rest_seconds]);

  useEffect(() => {
    if (timeLeft === null || timeLeft <= 0) return;
    const id = setInterval(() => {
      setTimeLeft((t) => {
        if (t === null || t <= 1) {
          clearInterval(id);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [timeLeft]);

  const minutes = timeLeft !== null ? Math.floor(timeLeft / 60) : 0;
  const seconds = timeLeft !== null ? timeLeft % 60 : 0;
  const restDone = timeLeft === 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>

      {/* Phase badge + exercise header */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <span style={{
          fontSize: "0.7rem", fontWeight: 700, padding: "0.2rem 0.6rem",
          borderRadius: "9999px", border: `1px solid ${phaseStyle.border}`,
          backgroundColor: phaseStyle.bg, color: phaseStyle.text,
          textTransform: "uppercase", letterSpacing: "0.06em",
        }}>
          {phaseStyle.label}
        </span>
        {current_exercise && (
          <span style={{ fontWeight: 700, fontSize: "1rem", color: "#111827" }}>
            {current_exercise}
            {set_number != null && (
              <span style={{ fontWeight: 400, color: "#6b7280", fontSize: "0.875rem" }}>
                {" "}— set {set_number}
              </span>
            )}
          </span>
        )}
      </div>

      {/* Message */}
      <p style={{ margin: 0, fontSize: "0.95rem", color: "#374151", lineHeight: 1.5 }}>
        {message}
      </p>

      {/* Rest timer */}
      {phase === "resting" && timeLeft !== null && (
        <div style={{
          padding: "0.875rem 1rem",
          borderRadius: "0.625rem",
          backgroundColor: restDone ? "#f0fdf4" : "#fefce8",
          border: `1px solid ${restDone ? "#bbf7d0" : "#fde68a"}`,
          textAlign: "center",
        }}>
          {restDone ? (
            <p style={{ margin: 0, fontWeight: 700, fontSize: "1.1rem", color: "#15803d" }}>
              Rest done — let&apos;s go!
            </p>
          ) : (
            <>
              <p style={{ margin: "0 0 0.25rem", fontSize: "0.75rem", color: "#a16207", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Rest
              </p>
              <p style={{ margin: 0, fontWeight: 800, fontSize: "2rem", color: "#92400e", fontVariantNumeric: "tabular-nums" }}>
                {minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`}
              </p>
            </>
          )}
        </div>
      )}

      {/* Suggested exercises (planning phase) */}
      {suggested_exercises.length > 0 && (
        <div>
          <p style={{ margin: "0 0 0.4rem", fontSize: "0.75rem", fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Workout Plan
          </p>
          <ol style={{ margin: 0, paddingLeft: "1.25rem", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            {suggested_exercises.map((ex, i) => (
              <li key={i} style={{ fontSize: "0.875rem", color: "#374151", textTransform: "capitalize" }}>
                {ex}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Logged workout confirmation */}
      {logged_workout && (
        <div style={{
          padding: "0.625rem 0.875rem",
          borderRadius: "0.5rem",
          backgroundColor: logged_workout.is_personal_record ? "#fefce8" : "#f9fafb",
          border: `1px solid ${logged_workout.is_personal_record ? "#fde68a" : "#e5e7eb"}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <span style={{ fontWeight: 600, fontSize: "0.875rem", color: "#111827", textTransform: "capitalize" }}>
              {logged_workout.exercise}
            </span>
            <span style={{ fontSize: "0.8125rem", color: "#6b7280", marginLeft: "0.4rem" }}>
              {logged_workout.sets}×{logged_workout.reps} @ {logged_workout.weight} {logged_workout.weight_unit}
            </span>
          </div>
          {logged_workout.is_personal_record && (
            <span style={{
              fontSize: "0.7rem", fontWeight: 700, padding: "0.15rem 0.5rem",
              borderRadius: "9999px", backgroundColor: "#fbbf24", color: "#78350f",
            }}>
              PR
            </span>
          )}
        </div>
      )}

      {/* Muscle targets from logged workout */}
      {logged_workout?.muscle_targets && logged_workout.muscle_targets.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
          {logged_workout.muscle_targets.map((t: MuscleTargetResponse, i: number) => (
            <span key={i} style={{
              fontSize: "0.7rem", padding: "0.15rem 0.5rem",
              borderRadius: "9999px",
              backgroundColor: t.role === "primary" ? "#dcfce7" : "#f3f4f6",
              color: t.role === "primary" ? "#166534" : "#374151",
              border: `1px solid ${t.role === "primary" ? "#bbf7d0" : "#d1d5db"}`,
            }}>
              {t.muscle_group}
            </span>
          ))}
        </div>
      )}

      {/* Done state */}
      {phase === "done" && (
        <div style={{
          padding: "0.75rem 1rem", borderRadius: "0.625rem",
          backgroundColor: "#f0fdf4", border: "1px solid #bbf7d0",
          textAlign: "center",
        }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: "0.95rem", color: "#15803d" }}>
            Workout complete. Good work.
          </p>
        </div>
      )}
    </div>
  );
}
