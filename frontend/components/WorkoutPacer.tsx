"use client";

import { useEffect, useRef, useState } from "react";
import type { PacerAPIResponse, PlanItem } from "@/lib/chat-api";
import type { PacerManualAction } from "@/lib/pacer-api";
import type { MuscleTargetResponse } from "@/lib/api";

interface WorkoutPacerProps {
  response: PacerAPIResponse;
  onAction: (action: PacerManualAction) => void;
}

const phaseColors: Record<string, { bg: string; text: string; border: string; label: string }> = {
  planning: { bg: "#eff6ff", text: "#1d4ed8", border: "#bfdbfe", label: "Planning" },
  active:   { bg: "#f0fdf4", text: "#15803d", border: "#bbf7d0", label: "Active"   },
  resting:  { bg: "#fefce8", text: "#a16207", border: "#fde68a", label: "Resting"  },
  done:     { bg: "#f3f4f6", text: "#374151", border: "#d1d5db", label: "Done"     },
};

// ---------------------------------------------------------------------------
// Inline plan editor — shown during planning phase
// ---------------------------------------------------------------------------

function PlanEditor({ plan, onAction }: { plan: PlanItem[]; onAction: (a: PacerManualAction) => void }) {
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editSets, setEditSets] = useState("");
  const [editReps, setEditReps] = useState("");
  const [addName, setAddName] = useState("");

  function openEdit(i: number, item: PlanItem) {
    setEditIdx(i);
    setEditSets(String(item.target_sets));
    setEditReps(String(item.target_reps));
  }

  function commitEdit(item: PlanItem) {
    const s = parseInt(editSets, 10);
    const r = parseInt(editReps, 10);
    if (!isNaN(s) && !isNaN(r)) {
      onAction({ type: "plan-change", exercise_name: item.name, target_sets: s, target_reps: r });
    }
    setEditIdx(null);
  }

  return (
    <div>
      <p style={{ margin: "0 0 0.4rem", fontSize: "0.75rem", fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        Workout Plan
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        {plan.map((item, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: "0.5rem",
            padding: "0.35rem 0.5rem", borderRadius: "0.375rem",
            backgroundColor: item.finalized ? "#f0fdf4" : "#f9fafb",
            border: `1px solid ${item.finalized ? "#bbf7d0" : "#e5e7eb"}`,
            opacity: item.finalized ? 0.6 : 1,
          }}>
            {/* Index */}
            <span style={{ fontSize: "0.7rem", color: "#9ca3af", width: "1rem", textAlign: "center", flexShrink: 0 }}>
              {item.finalized ? "✓" : i + 1}
            </span>

            {/* Name */}
            <span style={{ flex: 1, fontSize: "0.875rem", color: "#111827", textTransform: "capitalize" }}>
              {item.name}
            </span>

            {/* Inline sets×reps editor */}
            {!item.finalized && editIdx === i ? (
              <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                <input
                  type="number" min={1} max={20} value={editSets}
                  onChange={(e) => setEditSets(e.target.value)}
                  style={{ width: "2.5rem", fontSize: "0.8rem", padding: "0.15rem 0.3rem", borderRadius: "0.25rem", border: "1px solid #d1d5db", textAlign: "center" }}
                />
                <span style={{ fontSize: "0.7rem", color: "#6b7280" }}>×</span>
                <input
                  type="number" min={1} max={50} value={editReps}
                  onChange={(e) => setEditReps(e.target.value)}
                  style={{ width: "2.5rem", fontSize: "0.8rem", padding: "0.15rem 0.3rem", borderRadius: "0.25rem", border: "1px solid #d1d5db", textAlign: "center" }}
                />
                <button onClick={() => commitEdit(item)} style={btnStyle("#15803d", "#dcfce7")}>✓</button>
                <button onClick={() => setEditIdx(null)} style={btnStyle("#6b7280", "#f3f4f6")}>✕</button>
              </div>
            ) : (
              <>
                <span
                  onClick={() => !item.finalized && openEdit(i, item)}
                  title={item.finalized ? undefined : "Click to edit sets/reps"}
                  style={{
                    fontSize: "0.75rem", color: "#6b7280", whiteSpace: "nowrap",
                    cursor: item.finalized ? "default" : "pointer",
                    padding: "0.1rem 0.25rem", borderRadius: "0.25rem",
                    border: item.finalized ? "none" : "1px dashed #d1d5db",
                  }}
                >
                  {item.target_sets}×{item.target_reps}
                </span>
                {!item.finalized && (
                  <button
                    onClick={() => onAction({ type: "plan-remove", exercise_name: item.name })}
                    title="Remove"
                    style={btnStyle("#dc2626", "#fee2e2")}
                  >
                    ✕
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {/* Add exercise row */}
      <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem" }}>
        <input
          type="text"
          placeholder="Add exercise…"
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && addName.trim()) {
              onAction({ type: "plan-add", exercise_name: addName.trim() });
              setAddName("");
            }
          }}
          style={{
            flex: 1, fontSize: "0.8rem", padding: "0.3rem 0.5rem",
            borderRadius: "0.375rem", border: "1px solid #d1d5db",
          }}
        />
        <button
          onClick={() => {
            if (addName.trim()) {
              onAction({ type: "plan-add", exercise_name: addName.trim() });
              setAddName("");
            }
          }}
          style={btnStyle("#1d4ed8", "#eff6ff")}
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active-phase quick actions
// ---------------------------------------------------------------------------

function ActiveActions({ currentExercise, onAction }: { currentExercise: string | null; onAction: (a: PacerManualAction) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [weight, setWeight] = useState("");
  const [reps, setReps] = useState("");

  function submitWithNumbers() {
    const w = parseFloat(weight) || undefined;
    const r = parseInt(reps, 10) || undefined;
    onAction({ type: "set-done", reps: r, weight: w });
    setShowForm(false);
    setWeight("");
    setReps("");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button onClick={() => onAction({ type: "set-done" })} style={primaryBtnStyle}>
          Set Done
        </button>
        <button
          onClick={() => setShowForm((v) => !v)}
          style={secondaryBtnStyle}
          title="Log with specific weight / reps"
        >
          Done with numbers…
        </button>
        {currentExercise && (
          <button onClick={() => onAction({ type: "skip" })} style={ghostBtnStyle}>
            Skip
          </button>
        )}
      </div>

      {showForm && (
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="number" placeholder="Weight (lbs)" value={weight}
            onChange={(e) => setWeight(e.target.value)}
            style={numInputStyle}
          />
          <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>×</span>
          <input
            type="number" placeholder="Reps" value={reps}
            onChange={(e) => setReps(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitWithNumbers()}
            style={numInputStyle}
          />
          <button onClick={submitWithNumbers} style={primaryBtnStyle}>Log</button>
          <button onClick={() => setShowForm(false)} style={ghostBtnStyle}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared button styles
// ---------------------------------------------------------------------------

function btnStyle(color: string, bg: string): React.CSSProperties {
  return {
    fontSize: "0.7rem", fontWeight: 700, padding: "0.2rem 0.45rem",
    borderRadius: "0.25rem", border: `1px solid ${color}20`,
    backgroundColor: bg, color, cursor: "pointer", lineHeight: 1.2,
  };
}

const primaryBtnStyle: React.CSSProperties = {
  fontSize: "0.8rem", fontWeight: 700,
  padding: "0.4rem 0.875rem", borderRadius: "0.375rem",
  border: "none", backgroundColor: "#111827", color: "white",
  cursor: "pointer",
};

const secondaryBtnStyle: React.CSSProperties = {
  fontSize: "0.8rem", fontWeight: 600,
  padding: "0.4rem 0.75rem", borderRadius: "0.375rem",
  border: "1px solid #d1d5db", backgroundColor: "white", color: "#374151",
  cursor: "pointer",
};

const ghostBtnStyle: React.CSSProperties = {
  fontSize: "0.8rem", color: "#6b7280",
  padding: "0.4rem 0.6rem", borderRadius: "0.375rem",
  border: "1px solid #e5e7eb", backgroundColor: "transparent",
  cursor: "pointer",
};

const numInputStyle: React.CSSProperties = {
  width: "6rem", fontSize: "0.8rem",
  padding: "0.3rem 0.5rem", borderRadius: "0.375rem",
  border: "1px solid #d1d5db",
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function WorkoutPacer({ response, onAction }: WorkoutPacerProps) {
  const {
    message,
    phase,
    rest_seconds,
    current_exercise,
    set_number,
    suggested_exercises,
    logged_workout,
    total_exercises,
    completed_exercises,
    current_exercise_sets_done,
    current_exercise_sets_total,
    session_type,
    current_plan,
  } = response;

  const phaseStyle = phaseColors[phase] ?? phaseColors.planning;

  // ---------------------------------------------------------------------------
  // Rest countdown timer
  // ---------------------------------------------------------------------------
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const restKeyRef = useRef<number>(0);
  const announcedRef = useRef<number>(-1);

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

  useEffect(() => {
    if (timeLeft !== 0) return;
    const currentKey = restKeyRef.current;
    if (announcedRef.current === currentKey) return;
    announcedRef.current = currentKey;

    if (typeof window !== "undefined" && window.speechSynthesis) {
      const utterance = new SpeechSynthesisUtterance("Rest done. Let's go!");
      utterance.rate = 1.1;
      utterance.pitch = 1.0;
      utterance.volume = 0.8;
      window.speechSynthesis.speak(utterance);
    }
  }, [timeLeft]);

  const minutes = timeLeft !== null ? Math.floor(timeLeft / 60) : 0;
  const seconds = timeLeft !== null ? timeLeft % 60 : 0;
  const restDone = timeLeft === 0;

  // ---------------------------------------------------------------------------
  // Progress calculations
  // ---------------------------------------------------------------------------
  const hasProgress = total_exercises > 0;
  const progressPercent = hasProgress
    ? Math.round((completed_exercises / total_exercises) * 100)
    : 0;

  // Use current_plan for the plan editor; fall back to suggested_exercises names for planning phase
  const planForEditor: PlanItem[] =
    current_plan.length > 0
      ? current_plan
      : suggested_exercises.map((name) => ({
          name,
          target_sets: 3,
          target_reps: 10,
          sets_done: 0,
          finalized: false,
        }));

  const showPlanEditor = planForEditor.length > 0 && phase !== "done";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>

      {/* Session header with progress */}
      {hasProgress && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: "0.5rem",
        }}>
          {session_type && (
            <span style={{
              fontSize: "0.7rem", fontWeight: 700, padding: "0.15rem 0.5rem",
              borderRadius: "9999px", backgroundColor: "#f3f4f6",
              color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em",
            }}>
              {session_type}
            </span>
          )}
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <div style={{
              flex: 1, height: "6px", borderRadius: "3px",
              backgroundColor: "#e5e7eb", overflow: "hidden",
            }}>
              <div style={{
                width: `${progressPercent}%`,
                height: "100%",
                borderRadius: "3px",
                backgroundColor: progressPercent === 100 ? "#22c55e" : "#3b82f6",
                transition: "width 0.4s ease",
              }} />
            </div>
            <span style={{ fontSize: "0.7rem", color: "#6b7280", fontWeight: 600, whiteSpace: "nowrap" }}>
              {completed_exercises}/{total_exercises}
            </span>
          </div>
        </div>
      )}

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
        {current_exercise_sets_total > 0 && phase !== "done" && (
          <span style={{
            fontSize: "0.7rem", fontWeight: 600, color: "#9ca3af",
            marginLeft: "auto",
          }}>
            {current_exercise_sets_done}/{current_exercise_sets_total} sets
          </span>
        )}
      </div>

      {/* Message */}
      <p style={{ margin: 0, fontSize: "0.95rem", color: "#374151", lineHeight: 1.5 }}>
        {message}
      </p>

      {/* Active-phase quick actions */}
      {phase === "active" && (
        <ActiveActions currentExercise={current_exercise} onAction={onAction} />
      )}

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

      {/* Plan editor (all phases except done) */}
      {showPlanEditor && (
        <PlanEditor plan={planForEditor} onAction={onAction} />
      )}

      {/* Logged workout confirmation */}
      {logged_workout && (
        <div style={{
          padding: "0.625rem 0.875rem",
          borderRadius: "0.5rem",
          backgroundColor: logged_workout.is_personal_record ? "#fefce8" : "#f0fdf4",
          border: `1px solid ${logged_workout.is_personal_record ? "#fde68a" : "#bbf7d0"}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <span style={{ fontWeight: 600, fontSize: "0.75rem", color: "#15803d", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Logged
            </span>
            <div style={{ marginTop: "0.15rem" }}>
              <span style={{ fontWeight: 600, fontSize: "0.875rem", color: "#111827", textTransform: "capitalize" }}>
                {logged_workout.exercise}
              </span>
              <span style={{ fontSize: "0.8125rem", color: "#6b7280", marginLeft: "0.4rem" }}>
                {logged_workout.sets}×{logged_workout.reps} @ {logged_workout.weight} {logged_workout.weight_unit}
              </span>
            </div>
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
          {hasProgress && (
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem", color: "#6b7280" }}>
              {completed_exercises} exercise{completed_exercises !== 1 ? "s" : ""} logged
            </p>
          )}
        </div>
      )}
    </div>
  );
}
