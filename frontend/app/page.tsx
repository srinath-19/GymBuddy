"use client";

import { useCallback, useEffect, useState } from "react";
import VoiceInput from "@/components/VoiceInput";
import { getWorkouts, logWorkout, WorkoutLogResponse } from "@/lib/api";

type UIState = "idle" | "submitting" | "error";

export default function HomePage() {
  const [workouts, setWorkouts] = useState<WorkoutLogResponse[]>([]);
  const [uiState, setUiState] = useState<UIState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastLogged, setLastLogged] = useState<WorkoutLogResponse | null>(null);
  const [historyError, setHistoryError] = useState(false);

  const loadWorkouts = useCallback(async () => {
    try {
      const data = await getWorkouts();
      setWorkouts(data);
      setHistoryError(false);
    } catch {
      setHistoryError(true);
    }
  }, []);

  useEffect(() => {
    void loadWorkouts();
  }, [loadWorkouts]);

  const handleTranscript = useCallback(
    async (text: string) => {
      setUiState("submitting");
      setErrorMessage(null);
      setLastLogged(null);

      try {
        const record = await logWorkout(text);
        setLastLogged(record);
        setUiState("idle");
        await loadWorkouts();
      } catch (err) {
        setUiState("error");
        setErrorMessage(
          err instanceof Error ? err.message : "Something went wrong."
        );
      }
    },
    [loadWorkouts]
  );

  return (
    <main style={{ maxWidth: "680px", margin: "0 auto", padding: "2rem 1rem" }}>
      <h1
        style={{ fontSize: "1.75rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        GymBuddy
      </h1>
      <p style={{ color: "#6b7280", marginTop: 0, marginBottom: "2rem" }}>
        Speak or type your workout to log it instantly.
      </p>

      <section aria-label="Log a workout" style={{ marginBottom: "2.5rem" }}>
        <VoiceInput
          onTranscript={handleTranscript}
          disabled={uiState === "submitting"}
        />

        {uiState === "submitting" && (
          <p style={{ color: "#6b7280", marginTop: "0.75rem" }}>
            Parsing and saving your workout...
          </p>
        )}

        {uiState === "error" && errorMessage && (
          <p role="alert" style={{ color: "#dc2626", marginTop: "0.75rem" }}>
            {errorMessage}
          </p>
        )}

        {lastLogged && uiState === "idle" && (
          <div
            role="status"
            style={{
              marginTop: "1rem",
              padding: "1rem",
              backgroundColor: "#f0fdf4",
              border: "1px solid #86efac",
              borderRadius: "0.5rem",
            }}
          >
            <strong>Logged:</strong>{" "}
            {lastLogged.exercise} &mdash; {lastLogged.sets}&times;
            {lastLogged.reps} @ {lastLogged.weight} {lastLogged.weight_unit}
            {lastLogged.notes && (
              <em style={{ color: "#6b7280" }}> ({lastLogged.notes})</em>
            )}
          </div>
        )}
      </section>

      <section aria-label="Workout history">
        <h2
          style={{
            fontSize: "1.25rem",
            fontWeight: 600,
            marginBottom: "1rem",
            marginTop: 0,
          }}
        >
          Recent Workouts
        </h2>

        {historyError && (
          <p role="alert" style={{ color: "#b45309", marginBottom: "0.75rem" }}>
            Could not load workout history. Is the backend running?
          </p>
        )}

        {!historyError && workouts.length === 0 ? (
          <p style={{ color: "#9ca3af" }}>No workouts logged yet.</p>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            {workouts.map((w) => (
              <li
                key={w.id}
                style={{
                  padding: "0.875rem 1rem",
                  backgroundColor: "white",
                  border: "1px solid #e5e7eb",
                  borderRadius: "0.5rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: "0.5rem",
                }}
              >
                <div>
                  <span style={{ fontWeight: 600 }}>{w.exercise}</span>
                  <span style={{ color: "#6b7280", marginLeft: "0.5rem" }}>
                    {w.sets}&times;{w.reps} @ {w.weight} {w.weight_unit}
                  </span>
                  {w.notes && (
                    <p
                      style={{
                        fontSize: "0.875rem",
                        color: "#9ca3af",
                        margin: "0.25rem 0 0",
                      }}
                    >
                      {w.notes}
                    </p>
                  )}
                </div>
                <time
                  dateTime={w.logged_at}
                  style={{
                    fontSize: "0.75rem",
                    color: "#9ca3af",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {new Date(w.logged_at).toLocaleDateString()}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
