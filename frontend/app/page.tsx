"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import VoiceInput from "@/components/VoiceInput";
import {
  addWorkoutManually,
  AgentActionResponse,
  deleteWorkout,
  getExpectedMuscles,
  getRequiredMuscles,
  getSessions,
  getWorkouts,
  logWorkout,
  ManualWorkoutRequest,
  updateWorkout,
  WorkoutLogResponse,
  WorkoutSession,
  WorkoutUpdateRequest,
} from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

type UIState = "idle" | "submitting" | "error";

// ---------------------------------------------------------------------------
// Day-grouping helper
// ---------------------------------------------------------------------------
type DayGroup = {
  date: string;          // "YYYY-MM-DD"
  label: string;         // "Wednesday, April 15"
  session: WorkoutSession | null;
  workouts: WorkoutLogResponse[];
};

function groupByDay(workouts: WorkoutLogResponse[], sessions: WorkoutSession[]): DayGroup[] {
  const map = new Map<string, WorkoutLogResponse[]>();
  for (const w of workouts) {
    const key = w.logged_at.slice(0, 10); // "YYYY-MM-DD"
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(w);
  }
  const sessionMap = new Map(sessions.map((s) => [s.date, s]));
  const groups: DayGroup[] = [];
  for (const [date, ws] of map) {
    const d = new Date(date + "T12:00:00"); // noon UTC-safe parse
    groups.push({
      date,
      label: d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
      session: sessionMap.get(date) ?? null,
      workouts: ws,
    });
  }
  // Already ordered newest-first from API; map preserves insertion order
  return groups;
}

// ---------------------------------------------------------------------------
// ActionCard — voice/agent result feedback
// ---------------------------------------------------------------------------
function ActionCard({ action }: { action: AgentActionResponse }) {
  const w = action.workout;

  if (action.action === "session_started" && action.session) {
    return (
      <div role="status" style={{
        marginTop: "1rem", padding: "1rem",
        backgroundColor: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "0.5rem",
      }}>
        {action.message && (
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.9rem", fontWeight: 500, color: "#1e40af", lineHeight: 1.5 }}>
            {action.message}
          </p>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{
            fontSize: "0.7rem", fontWeight: 600,
            backgroundColor: "#dbeafe", color: "#1d4ed8",
            padding: "0.15rem 0.55rem", borderRadius: "9999px",
            border: "1px solid #bfdbfe", textTransform: "capitalize",
          }}>
            {action.session.session_type}
          </span>
          {action.session.notes && (
            <em style={{ color: "#6b7280", fontSize: "0.8rem" }}>{action.session.notes}</em>
          )}
        </div>
      </div>
    );
  }

  if ((action.action === "logged" || action.action === "updated") && w) {
    return (
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
        {action.message && (
          <p style={{ margin: "0 0 0.6rem", fontSize: "0.9rem", fontWeight: 500, color: "#166534", lineHeight: 1.5 }}>
            {action.message}
          </p>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.8rem", color: "#374151" }}>
            {w.exercise} &mdash; {w.sets}&times;{w.reps} @ {w.weight} {w.weight_unit}
          </span>
          {w.notes && <em style={{ color: "#6b7280", fontSize: "0.8rem" }}> ({w.notes})</em>}
          {w.is_personal_record && (
            <span style={{
              display: "inline-block",
              backgroundColor: "#fef08a",
              color: "#713f12",
              fontSize: "0.75rem",
              fontWeight: 700,
              padding: "0.1rem 0.5rem",
              borderRadius: "9999px",
              border: "1px solid #fde047",
              whiteSpace: "nowrap",
            }}>
              New PR!
            </span>
          )}
        </div>
        {w.muscle_targets.length > 0 && (
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
            {w.muscle_targets.filter((t) => t.role === "primary").map((t) => (
              <span key={t.muscle_group} style={{
                fontSize: "0.7rem", backgroundColor: "#dcfce7", color: "#166534",
                padding: "0.1rem 0.45rem", borderRadius: "9999px", border: "1px solid #bbf7d0",
              }}>{t.muscle_group}</span>
            ))}
            {w.muscle_targets.filter((t) => t.role === "secondary").map((t) => (
              <span key={t.muscle_group} style={{
                fontSize: "0.7rem", backgroundColor: "#f1f5f9", color: "#475569",
                padding: "0.1rem 0.45rem", borderRadius: "9999px", border: "1px solid #e2e8f0",
              }}>{t.muscle_group}</span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (action.action === "deleted") {
    return (
      <div role="status" style={{
        marginTop: "1rem", padding: "1rem",
        backgroundColor: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "0.5rem",
      }}>
        <p style={{ margin: 0, fontSize: "0.9rem", fontWeight: 500, color: "#9a3412", lineHeight: 1.5 }}>
          {action.message}
        </p>
      </div>
    );
  }

  if (action.action === "found" && action.workouts && action.workouts.length > 0) {
    const expectedMuscles = action.session
      ? getExpectedMuscles(action.session.session_type)
      : [];
    const requiredMuscles = action.session
      ? getRequiredMuscles(action.session.session_type)
      : [];
    const hitMuscles = new Set<string>(
      action.workouts.flatMap((w) =>
        w.muscle_targets.filter((t) => t.role === "primary").map((t) => t.muscle_group)
      )
    );
    const coveredMuscles = expectedMuscles.filter((m) => hitMuscles.has(m));
    const missingMuscles = expectedMuscles.filter((m) => !hitMuscles.has(m));
    const allRequiredCovered =
      requiredMuscles.length > 0 && requiredMuscles.every((m) => hitMuscles.has(m));

    return (
      <div role="status" style={{
        marginTop: "1rem", padding: "1rem",
        backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "0.5rem",
      }}>
        {/* LLM sentence summary — always shown at top (TTS-ready) */}
        {action.message && (
          <p style={{
            margin: "0 0 0.6rem",
            fontSize: "0.9rem",
            fontWeight: 500,
            color: "#1e293b",
            lineHeight: 1.5,
          }}>
            {action.message}
          </p>
        )}
        {/* Session badge + coverage label */}
        {action.session && (
          <div style={{ marginBottom: "0.6rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{
              fontSize: "0.7rem", fontWeight: 600,
              backgroundColor: "#eff6ff", color: "#1d4ed8",
              padding: "0.15rem 0.55rem", borderRadius: "9999px",
              border: "1px solid #bfdbfe", textTransform: "capitalize",
            }}>
              {action.session.session_type}
            </span>
            {expectedMuscles.length > 0 && (
              <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                {allRequiredCovered
                  ? "Session complete!"
                  : `${requiredMuscles.filter((m) => hitMuscles.has(m)).length}/${requiredMuscles.length} main muscles covered`}
              </span>
            )}
          </div>
        )}
        {/* Muscle coverage pills */}
        {expectedMuscles.length > 0 && (
          <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            {coveredMuscles.map((m) => (
              <span key={m} style={{
                fontSize: "0.7rem", backgroundColor: "#dcfce7", color: "#166534",
                padding: "0.1rem 0.45rem", borderRadius: "9999px", border: "1px solid #bbf7d0",
              }}>{m}</span>
            ))}
            {missingMuscles.map((m) => (
              <span key={m} style={{
                fontSize: "0.7rem", backgroundColor: "#fff7ed", color: "#c2410c",
                padding: "0.1rem 0.45rem", borderRadius: "9999px", border: "1px solid #fed7aa",
              }}>{m}</span>
            ))}
          </div>
        )}
        {/* Workout list */}
        <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.3rem" }}>
          {action.workouts.length} workout{action.workouts.length !== 1 ? "s" : ""}
        </div>
        <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          {action.workouts.map((w) => (
            <li key={w.id} style={{ fontSize: "0.875rem", color: "#374151" }}>
              <span style={{ fontWeight: 600 }}>{w.exercise}</span>{" "}
              <span style={{ color: "#6b7280" }}>{w.sets}&times;{w.reps} @ {w.weight} {w.weight_unit}</span>{" "}
              <span style={{ color: "#9ca3af", fontSize: "0.75rem" }}>{new Date(w.logged_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (action.message) {
    return (
      <div role="status" style={{
        marginTop: "1rem", padding: "1rem",
        backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "0.5rem",
        color: "#374151", fontSize: "0.875rem",
      }}>
        {action.message}
      </div>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// WorkoutForm — shared form for manual-add and inline-edit
// ---------------------------------------------------------------------------
interface WorkoutFormValues {
  exercise: string;
  sets: string;
  reps: string;
  weight: string;
  weight_unit: "lbs" | "kg";
  notes: string;
  date: string;  // "YYYY-MM-DD"
}

function blankForm(): WorkoutFormValues {
  return {
    exercise: "", sets: "", reps: "", weight: "", weight_unit: "lbs", notes: "",
    date: new Date().toISOString().slice(0, 10),
  };
}

function fromWorkout(w: WorkoutLogResponse): WorkoutFormValues {
  return {
    exercise: w.exercise,
    sets: String(w.sets),
    reps: String(w.reps),
    weight: String(w.weight),
    weight_unit: w.weight_unit as "lbs" | "kg",
    notes: w.notes ?? "",
    date: w.logged_at.slice(0, 10),
  };
}

const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.375rem",
  fontSize: "0.875rem",
  width: "100%",
  boxSizing: "border-box",
};

interface WorkoutFormProps {
  initial: WorkoutFormValues;
  onSave: (values: WorkoutFormValues) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
}

function WorkoutForm({ initial, onSave, onCancel, saving }: WorkoutFormProps) {
  const [values, setValues] = useState<WorkoutFormValues>(initial);

  function set(field: keyof WorkoutFormValues, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSave(values);
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.75rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "0.4rem" }}>
        <input
          style={inputStyle}
          placeholder="Exercise (e.g. bench press)"
          value={values.exercise}
          onChange={(e) => set("exercise", e.target.value)}
          required
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.4rem" }}>
          <input style={inputStyle} type="number" min={1} placeholder="Sets" value={values.sets}
            onChange={(e) => set("sets", e.target.value)} required />
          <input style={inputStyle} type="number" min={1} placeholder="Reps" value={values.reps}
            onChange={(e) => set("reps", e.target.value)} required />
          <input style={inputStyle} type="number" min={0} step="any" placeholder="Weight" value={values.weight}
            onChange={(e) => set("weight", e.target.value)} required />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.4rem", alignItems: "center" }}>
          <select
            style={{ ...inputStyle, width: "auto" }}
            value={values.weight_unit}
            onChange={(e) => set("weight_unit", e.target.value as "lbs" | "kg")}
          >
            <option value="lbs">lbs</option>
            <option value="kg">kg</option>
          </select>
          <input style={inputStyle} placeholder="Notes (optional)" value={values.notes}
            onChange={(e) => set("notes", e.target.value)} />
        </div>
        <input
          style={inputStyle}
          type="date"
          value={values.date}
          onChange={(e) => set("date", e.target.value)}
          required
        />
      </div>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="submit"
          disabled={saving}
          style={{
            padding: "0.35rem 0.85rem",
            backgroundColor: "#111827",
            color: "white",
            border: "none",
            borderRadius: "0.375rem",
            fontSize: "0.875rem",
            cursor: saving ? "not-allowed" : "pointer",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{
            padding: "0.35rem 0.85rem",
            backgroundColor: "transparent",
            color: "#6b7280",
            border: "1px solid #d1d5db",
            borderRadius: "0.375rem",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function HomePage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [workouts, setWorkouts] = useState<WorkoutLogResponse[]>([]);
  const [sessions, setSessions] = useState<WorkoutSession[]>([]);
  const [uiState, setUiState] = useState<UIState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<AgentActionResponse | null>(null);
  const [historyError, setHistoryError] = useState(false);

  // Edit / delete state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [crudError, setCrudError] = useState<string | null>(null);

  // Manual-add form
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);
  const manualFormKey = useRef(0); // bump to reset form after save

  useEffect(() => {
    createClient()
      .auth.getSession()
      .then(({ data }) => {
        if (!data.session) {
          router.replace("/login");
        } else {
          setUserEmail(data.session.user.email ?? null);
          setReady(true);
        }
      });
  }, [router]);

  const loadWorkouts = useCallback(async () => {
    try {
      const [workoutData, sessionData] = await Promise.all([getWorkouts(), getSessions()]);
      setWorkouts(workoutData);
      setSessions(sessionData);
      setHistoryError(false);
    } catch {
      setHistoryError(true);
    }
  }, []);

  useEffect(() => {
    if (ready) void loadWorkouts();
  }, [ready, loadWorkouts]);

  // Voice / text agent submit
  const handleTranscript = useCallback(
    async (text: string) => {
      setUiState("submitting");
      setErrorMessage(null);
      setLastAction(null);

      try {
        const result = await logWorkout(text);
        setLastAction(result);
        setUiState("idle");
        await loadWorkouts();
      } catch (err) {
        setUiState("error");
        setErrorMessage(err instanceof Error ? err.message : "Something went wrong.");
      }
    },
    [loadWorkouts]
  );

  // Delete a workout — optimistic: remove from state immediately
  const handleDelete = useCallback(
    async (id: string) => {
      setCrudError(null);
      setWorkouts((prev) => prev.filter((w) => w.id !== id));
      try {
        await deleteWorkout(id);
      } catch (err) {
        setCrudError(err instanceof Error ? err.message : "Delete failed.");
        await loadWorkouts(); // restore list on failure
      }
    },
    [loadWorkouts]
  );

  // Save edits — apply form values to list immediately, correct with server response
  const handleEditSave = useCallback(
    async (id: string, values: WorkoutFormValues) => {
      setCrudError(null);
      setEditingId(null); // close form immediately

      // Optimistic: patch the list item right now with whatever the form has
      const parsedSets = parseInt(values.sets, 10);
      const parsedReps = parseInt(values.reps, 10);
      const parsedWeight = parseFloat(values.weight);
      setWorkouts((prev) =>
        prev.map((w) =>
          w.id === id
            ? {
                ...w,
                exercise: values.exercise.trim().toLowerCase() || w.exercise,
                sets: Number.isFinite(parsedSets) ? parsedSets : w.sets,
                reps: Number.isFinite(parsedReps) ? parsedReps : w.reps,
                weight: Number.isFinite(parsedWeight) ? parsedWeight : w.weight,
                weight_unit: values.weight_unit,
                notes: values.notes.trim() || null,
              }
            : w
        )
      );

      const payload: WorkoutUpdateRequest = {
        exercise: values.exercise.trim().toLowerCase() || undefined,
        sets: Number.isFinite(parsedSets) ? parsedSets : undefined,
        reps: Number.isFinite(parsedReps) ? parsedReps : undefined,
        weight: Number.isFinite(parsedWeight) ? parsedWeight : undefined,
        weight_unit: values.weight_unit,
        notes: values.notes.trim() || undefined,
      };
      try {
        await updateWorkout(id, payload);
        // Full reload so every card reflects updated PR status (weight change can affect
        // is_personal_record for all workouts of that exercise, not just this one)
        await loadWorkouts();
      } catch (err) {
        setCrudError(err instanceof Error ? err.message : "Update failed.");
        setEditingId(id); // reopen form on failure
        await loadWorkouts(); // restore original data
      }
    },
    [loadWorkouts]
  );

  // Manually add — insert a placeholder immediately, swap in the real entry on success
  const handleManualAdd = useCallback(
    async (values: WorkoutFormValues) => {
      setCrudError(null);
      manualFormKey.current += 1;
      setShowManualForm(false); // close form immediately
      setManualSaving(true);

      const tempId = `pending-${Date.now()}`;
      const optimisticDate = values.date
        ? `${values.date}T00:00:00.000Z`
        : new Date().toISOString();
      const optimistic: WorkoutLogResponse = {
        id: tempId,
        user_id: null,
        exercise: values.exercise.trim(),
        sets: parseInt(values.sets, 10),
        reps: parseInt(values.reps, 10),
        weight: parseFloat(values.weight),
        weight_unit: values.weight_unit,
        notes: values.notes.trim() || null,
        logged_at: optimisticDate,
        created_at: new Date().toISOString(),
        is_personal_record: false,
        muscle_targets: [],
      };
      setWorkouts((prev) => [optimistic, ...prev]); // show immediately

      const payload: ManualWorkoutRequest = {
        exercise: values.exercise.trim(),
        sets: parseInt(values.sets, 10),
        reps: parseInt(values.reps, 10),
        weight: parseFloat(values.weight),
        weight_unit: values.weight_unit,
        notes: values.notes.trim() || undefined,
        logged_at: values.date || undefined,
      };
      try {
        await addWorkoutManually(payload);
        // Full reload so every card reflects updated PR status
        await loadWorkouts();
      } catch (err) {
        setCrudError(err instanceof Error ? err.message : "Could not add workout.");
        setWorkouts((prev) => prev.filter((w) => w.id !== tempId)); // remove placeholder
        setShowManualForm(true);
        await loadWorkouts();
      } finally {
        setManualSaving(false);
      }
    },
    [loadWorkouts]
  );

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
  };

  if (!ready) return null;

  return (
    <main style={{ maxWidth: "680px", margin: "0 auto", padding: "2rem 1rem" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
        <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0 }}>GymBuddy</h1>
        <button
          onClick={handleSignOut}
          style={{ fontSize: "0.875rem", color: "#6b7280", background: "none", border: "none", cursor: "pointer", padding: "0.25rem 0.5rem" }}
        >
          Sign out
        </button>
      </div>
      {userEmail && (
        <p style={{ color: "#9ca3af", fontSize: "0.875rem", marginTop: "0.25rem", marginBottom: "2rem" }}>
          {userEmail}
        </p>
      )}
      {!userEmail && (
        <p style={{ color: "#6b7280", marginTop: 0, marginBottom: "2rem" }}>
          Speak or type your workout to log it instantly.
        </p>
      )}

      {/* Voice / text input */}
      <section aria-label="Log a workout" style={{ marginBottom: "2.5rem" }}>
        <VoiceInput onTranscript={handleTranscript} disabled={uiState === "submitting"} />

        {uiState === "submitting" && (
          <p style={{ color: "#6b7280", marginTop: "0.75rem" }}>Parsing and saving your workout...</p>
        )}

        {uiState === "error" && errorMessage && (
          <p role="alert" style={{ color: "#dc2626", marginTop: "0.75rem" }}>{errorMessage}</p>
        )}

        {lastAction && uiState === "idle" && <ActionCard action={lastAction} />}
      </section>

      {/* Workout history */}
      <section aria-label="Workout history">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>Recent Workouts</h2>
          <button
            onClick={() => { setShowManualForm((v) => !v); setEditingId(null); }}
            style={{
              fontSize: "0.8rem",
              color: showManualForm ? "#6b7280" : "#2563eb",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "0.2rem 0.4rem",
            }}
          >
            {showManualForm ? "Cancel" : "+ Add manually"}
          </button>
        </div>

        {/* Manual-add form */}
        {showManualForm && (
          <div style={{
            marginBottom: "1.25rem",
            padding: "1rem",
            backgroundColor: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "0.5rem",
          }}>
            <p style={{ margin: "0 0 0.5rem", fontWeight: 600, fontSize: "0.875rem", color: "#374151" }}>
              Add workout manually
            </p>
            <WorkoutForm
              key={manualFormKey.current}
              initial={blankForm()}
              onSave={handleManualAdd}
              onCancel={() => setShowManualForm(false)}
              saving={manualSaving}
            />
          </div>
        )}

        {crudError && (
          <p role="alert" style={{ color: "#dc2626", marginBottom: "0.75rem", fontSize: "0.875rem" }}>
            {crudError}
          </p>
        )}

        {historyError && (
          <p role="alert" style={{ color: "#b45309", marginBottom: "0.75rem" }}>
            Could not load workout history. Is the backend running?
          </p>
        )}

        {!historyError && workouts.length === 0 ? (
          <p style={{ color: "#9ca3af" }}>No workouts logged yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
            {groupByDay(workouts, sessions).map((group) => (
              <div key={group.date}>
                {/* Day header */}
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "0.4rem 0.75rem",
                  backgroundColor: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "0.375rem",
                  marginBottom: "0.5rem",
                }}>
                  <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#374151" }}>
                    {group.label}
                  </span>
                  {group.session && (
                    <span style={{
                      fontSize: "0.7rem", fontWeight: 600,
                      backgroundColor: "#eff6ff", color: "#1d4ed8",
                      padding: "0.1rem 0.55rem", borderRadius: "9999px",
                      border: "1px solid #bfdbfe", textTransform: "capitalize",
                    }}>
                      {group.session.session_type}
                    </span>
                  )}
                </div>

                {/* Workout cards for this day */}
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {group.workouts.map((w) => (
                    <li
                      key={w.id}
                      style={{
                        padding: "0.875rem 1rem",
                        backgroundColor: "white",
                        border: w.is_personal_record ? "1px solid #fde047" : "1px solid #e5e7eb",
                        borderRadius: "0.5rem",
                      }}
                    >
                      {/* Card header row */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                            <span style={{ fontWeight: 600 }}>{w.exercise}</span>
                            <span style={{ color: "#6b7280" }}>
                              {w.sets}&times;{w.reps} @ {w.weight} {w.weight_unit}
                            </span>
                            {w.is_personal_record && (
                              <span style={{
                                fontSize: "0.7rem", fontWeight: 700,
                                backgroundColor: "#fef08a", color: "#713f12",
                                padding: "0.1rem 0.45rem", borderRadius: "9999px",
                                border: "1px solid #fde047", whiteSpace: "nowrap",
                              }}>
                                PR
                              </span>
                            )}
                          </div>
                          {w.notes && editingId !== w.id && (
                            <p style={{ fontSize: "0.875rem", color: "#9ca3af", margin: "0.25rem 0 0" }}>{w.notes}</p>
                          )}
                          {w.muscle_targets.length > 0 && editingId !== w.id && (
                            <div style={{ marginTop: "0.35rem", display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                              {w.muscle_targets.filter((t) => t.role === "primary").map((t) => (
                                <span
                                  key={t.muscle_group}
                                  title={t.specific_muscles.join(", ")}
                                  style={{
                                    fontSize: "0.65rem", backgroundColor: "#f0fdf4", color: "#166534",
                                    padding: "0.05rem 0.4rem", borderRadius: "9999px",
                                    border: "1px solid #bbf7d0", cursor: "default",
                                  }}
                                >
                                  {t.muscle_group}
                                </span>
                              ))}
                              {w.muscle_targets.filter((t) => t.role === "secondary").map((t) => (
                                <span
                                  key={t.muscle_group}
                                  title={t.specific_muscles.join(", ")}
                                  style={{
                                    fontSize: "0.65rem", backgroundColor: "#f1f5f9", color: "#475569",
                                    padding: "0.05rem 0.4rem", borderRadius: "9999px",
                                    border: "1px solid #e2e8f0", cursor: "default",
                                  }}
                                >
                                  {t.muscle_group}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Actions: time + edit + delete */}
                        <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", flexShrink: 0 }}>
                          <time dateTime={w.logged_at} style={{ fontSize: "0.75rem", color: "#9ca3af", whiteSpace: "nowrap" }}>
                            {new Date(w.logged_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                          </time>
                          <button
                            aria-label={`Edit ${w.exercise}`}
                            onClick={() => setEditingId(editingId === w.id ? null : w.id)}
                            style={{
                              background: "none", border: "none", cursor: "pointer",
                              color: editingId === w.id ? "#2563eb" : "#9ca3af",
                              fontSize: "0.8rem", padding: "0.15rem 0.3rem", lineHeight: 1,
                            }}
                            title="Edit"
                          >
                            ✎
                          </button>
                          <button
                            aria-label={`Delete ${w.exercise}`}
                            onClick={() => handleDelete(w.id)}
                            disabled={deletingId === w.id}
                            style={{
                              background: "none", border: "none",
                              cursor: deletingId === w.id ? "not-allowed" : "pointer",
                              color: "#f87171", fontSize: "0.8rem",
                              padding: "0.15rem 0.3rem", lineHeight: 1,
                              opacity: deletingId === w.id ? 0.5 : 1,
                            }}
                            title="Delete"
                          >
                            ✕
                          </button>
                        </div>
                      </div>

                      {/* Inline edit form */}
                      {editingId === w.id && (
                        <WorkoutForm
                          initial={fromWorkout(w)}
                          onSave={(values) => handleEditSave(w.id, values)}
                          onCancel={() => setEditingId(null)}
                          saving={false}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
