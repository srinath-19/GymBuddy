"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useRouter } from "next/navigation";
import VoiceInput from "@/components/VoiceInput";
import WakeWordIndicator from "@/components/WakeWordIndicator";
import {
  addWorkoutManually,
  AgentActionResponse,
  clientTz,
  deleteWorkout,
  getExpectedMuscles,
  getRequiredMuscles,
  getSessions,
  getWorkouts,
  logWorkoutFromAudioStreamed,
  logWorkoutStreamed,
  ManualWorkoutRequest,
  updateSession,
  updateWorkout,
  WorkoutLogResponse,
  WorkoutSession,
  WorkoutUpdateRequest,
} from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { useWakeWord } from "@/lib/useWakeWord";
import { useTTS } from "@/lib/useTTS";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ParticleTextEffect } from "@/components/ui/particle-text-effect";

const GYM_WORDS = [
  "SQUAT", "DEADLIFT", "BENCH", "PRESS", "GAINS",
  "PUMP", "GRIND", "FLEX", "REPS", "BEAST",
  "PR", "SETS", "LIFT", "POWER", "SHRED",
];

type UIState = "idle" | "submitting" | "error";

type DayGroup = {
  date: string;
  label: string;
  session: WorkoutSession | null;
  workouts: WorkoutLogResponse[];
};

/**
 * Local calendar date as "YYYY-MM-DD". Never use toISOString().slice(0, 10) for
 * this — that yields the *UTC* date, which is a day off for much of the day.
 */
function toLocalDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function groupByDay(workouts: WorkoutLogResponse[], sessions: WorkoutSession[]): DayGroup[] {
  const map = new Map<string, WorkoutLogResponse[]>();
  for (const w of workouts) {
    const key = toLocalDateKey(new Date(w.logged_at));
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(w);
  }
  const sessionMap = new Map(sessions.map((s) => [s.date, s]));
  for (const date of sessionMap.keys()) {
    if (!map.has(date)) map.set(date, []);
  }
  const groups: DayGroup[] = [];
  for (const [date, ws] of map) {
    const d = new Date(date + "T12:00:00");
    groups.push({
      date,
      label: d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
      session: sessionMap.get(date) ?? null,
      workouts: ws,
    });
  }
  return groups.sort((a, b) => b.date.localeCompare(a.date));
}

function getWeekBounds(offset: number): { start: string; end: string; label: string } {
  const now = new Date();
  const dow = now.getDay();
  const toMonday = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(now);
  mon.setDate(now.getDate() + toMonday + offset * 7);
  mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const label =
    offset === 0
      ? "This week"
      : mon.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " – " +
        sun.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { start: toLocalDateKey(mon), end: toLocalDateKey(sun), label };
}

// ---------------------------------------------------------------------------
// ActionCard — voice/agent result feedback
// ---------------------------------------------------------------------------
function ActionCard({ action }: { action: AgentActionResponse }) {
  const w = action.workout;

  if (action.action === "session_started" && action.session) {
    return (
      <div role="status" className="glass-light mt-4 p-4">
        {action.message && (
          <ReactMarkdown components={{ p: ({ children }) => <p className="m-0 mb-2 text-sm font-medium text-blue-200 leading-relaxed">{children}</p> }}>
            {action.message}
          </ReactMarkdown>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge className="bg-blue-500/20 text-blue-200 border-blue-400/40 capitalize text-xs">
            {action.session.session_type}
          </Badge>
          {action.session.notes && (
            <em className="text-white/50 text-sm">{action.session.notes}</em>
          )}
        </div>
      </div>
    );
  }

  if ((action.action === "logged" || action.action === "updated") && w) {
    return (
      <div role="status" className="glass-light mt-4 p-4 border-green-400/30">
        {action.message && (
          <ReactMarkdown components={{ p: ({ children }) => <p className="m-0 mb-2 text-sm font-medium text-green-200 leading-relaxed">{children}</p> }}>
            {action.message}
          </ReactMarkdown>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-white/80">
            {w.exercise} &mdash; {w.sets}&times;{w.reps} @ {w.weight} {w.weight_unit}
          </span>
          {w.notes && <em className="text-white/50 text-sm">({w.notes})</em>}
          {w.is_personal_record && (
            <span className="inline-flex items-center gap-1 bg-gradient-to-r from-yellow-400 to-amber-500 text-black font-extrabold text-xs px-3 py-1 rounded-full shadow-[0_0_14px_rgba(251,191,36,0.7)] tracking-wide">
              🏆 New PR!
            </span>
          )}
        </div>
        {w.muscle_targets.length > 0 && (
          <div className="mt-2 flex gap-1.5 flex-wrap">
            {w.muscle_targets.filter((t) => t.role === "primary").map((t) => (
              <Badge key={t.muscle_group} className="bg-green-500/20 text-green-300 border-green-500/30 text-[0.65rem]">
                {t.muscle_group}
              </Badge>
            ))}
            {w.muscle_targets.filter((t) => t.role === "secondary").map((t) => (
              <Badge key={t.muscle_group} className="bg-slate-500/20 text-slate-300 border-slate-500/30 text-[0.65rem]">
                {t.muscle_group}
              </Badge>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (action.action === "deleted") {
    return (
      <div role="status" className="glass-light mt-4 p-4 border-orange-400/30">
        <p className="m-0 text-sm font-medium text-orange-200 leading-relaxed">
          {action.message}
        </p>
      </div>
    );
  }

  if (action.action === "found" && action.workouts && action.workouts.length > 0) {
    const expectedMuscles = action.session ? getExpectedMuscles(action.session.session_type) : [];
    const requiredMuscles = action.session ? getRequiredMuscles(action.session.session_type) : [];
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
      <div role="status" className="glass-light mt-4 p-4">
        {action.message && (
          <ReactMarkdown components={{ p: ({ children }) => <p className="m-0 mb-2 text-sm font-medium text-white/90 leading-relaxed">{children}</p> }}>
            {action.message}
          </ReactMarkdown>
        )}
        {action.session && (
          <div className="mb-2 flex items-center gap-2 flex-wrap">
            <Badge className="bg-blue-500/20 text-blue-200 border-blue-400/40 capitalize text-xs">
              {action.session.session_type}
            </Badge>
            {expectedMuscles.length > 0 && (
              <span className="text-xs text-white/50">
                {allRequiredCovered
                  ? "Session complete!"
                  : `${requiredMuscles.filter((m) => hitMuscles.has(m)).length}/${requiredMuscles.length} main muscles covered`}
              </span>
            )}
          </div>
        )}
        {expectedMuscles.length > 0 && (
          <div className="flex gap-1.5 flex-wrap mb-2">
            {coveredMuscles.map((m) => (
              <Badge key={m} className="bg-green-500/20 text-green-300 border-green-500/30 text-[0.65rem]">{m}</Badge>
            ))}
            {missingMuscles.map((m) => (
              <Badge key={m} className="bg-orange-500/20 text-orange-300 border-orange-500/30 text-[0.65rem]">{m}</Badge>
            ))}
          </div>
        )}
        <div className="text-xs text-white/30 mb-1">
          {action.workouts.length} workout{action.workouts.length !== 1 ? "s" : ""}
        </div>
        <ul className="list-none p-0 m-0 flex flex-col gap-1 mt-2">
          {action.workouts.map((w) => (
            <li key={w.id} className="text-sm text-white/80">
              <span className="font-semibold">{w.exercise}</span>{" "}
              <span className="text-white/50">{w.sets}&times;{w.reps} @ {w.weight} {w.weight_unit}</span>{" "}
              <span className="text-white/30 text-xs">{new Date(w.logged_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (action.message) {
    return (
      <div role="status" className="glass-light mt-4 p-4 text-white/80 text-sm">
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
  date: string;
}

function blankForm(exercise = "", date?: string): WorkoutFormValues {
  return {
    exercise, sets: "", reps: "", weight: "", weight_unit: "lbs", notes: "",
    date: date ?? toLocalDateKey(new Date()),
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
    date: toLocalDateKey(new Date(w.logged_at)),
  };
}

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
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 mt-3">
      <Input
        className="glass-input"
        placeholder="Exercise (e.g. bench press)"
        value={values.exercise}
        onChange={(e) => set("exercise", e.target.value)}
        required
      />
      <div className="grid grid-cols-3 gap-2">
        <Input className="glass-input" type="number" min={1} placeholder="Sets" value={values.sets}
          onChange={(e) => set("sets", e.target.value)} required />
        <Input className="glass-input" type="number" min={1} placeholder="Reps" value={values.reps}
          onChange={(e) => set("reps", e.target.value)} required />
        <Input className="glass-input" type="number" min={0} step="any" placeholder="Weight" value={values.weight}
          onChange={(e) => set("weight", e.target.value)} required />
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-2 items-center">
        <select
          className="glass-input rounded-lg px-2 py-1 text-sm"
          value={values.weight_unit}
          onChange={(e) => set("weight_unit", e.target.value as "lbs" | "kg")}
        >
          <option value="lbs">lbs</option>
          <option value="kg">kg</option>
        </select>
        <Input className="glass-input" placeholder="Notes (optional)" value={values.notes}
          onChange={(e) => set("notes", e.target.value)} />
      </div>
      <Input
        className="glass-input"
        type="date"
        value={values.date}
        onChange={(e) => set("date", e.target.value)}
        required
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={saving}
          className="bg-white/10 hover:bg-white/20 border border-white/20 text-white text-sm"
          size="sm"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
          className="text-white/50 hover:text-white text-sm"
          size="sm"
        >
          Cancel
        </Button>
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
  const [streamMessage, setStreamMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<AgentActionResponse | null>(null);
  const [historyError, setHistoryError] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [crudError, setCrudError] = useState<string | null>(null);

  const [showManualForm, setShowManualForm] = useState(false);
  const [addForDate, setAddForDate] = useState<string | null>(null);
  const [manualSaving, setManualSaving] = useState(false);
  const manualFormKey = useRef(0);

  const [weekOffset, setWeekOffset] = useState(0);

  const [editSessionDate, setEditSessionDate] = useState<string | null>(null);
  const [editSessionInput, setEditSessionInput] = useState("");
  const [sessionSaving, setSessionSaving] = useState(false);

  useEffect(() => {
    createClient()
      .auth.getSession()
      .then(({ data }) => {
        if (!data.session) {
          router.replace("/login");
        } else {
          setUserEmail(data.session.user.email ?? null);
          try {
            const cw = sessionStorage.getItem("gymbuddy:workouts");
            const cs = sessionStorage.getItem("gymbuddy:sessions");
            if (cw) setWorkouts(JSON.parse(cw));
            if (cs) setSessions(JSON.parse(cs));
          } catch { /* sessionStorage unavailable */ }
          setReady(true);
        }
      });
  }, [router]);

  const loadWorkouts = useCallback(async () => {
    try {
      const [workoutData, sessionData] = await Promise.all([getWorkouts(), getSessions()]);
      setWorkouts(workoutData);
      setSessions(sessionData);
      try {
        sessionStorage.setItem("gymbuddy:workouts", JSON.stringify(workoutData));
        sessionStorage.setItem("gymbuddy:sessions", JSON.stringify(sessionData));
      } catch { /* storage full or unavailable */ }
      setHistoryError(false);
    } catch {
      setHistoryError(true);
    }
  }, []);

  useEffect(() => {
    if (ready) void loadWorkouts();
  }, [ready, loadWorkouts]);

  const tts = useTTS({
    voice: "echo",
    onStart: () => setTtsSuppressed(true),
    onEnd: () => setTtsSuppressed(false),
  });
  const [ttsSuppressed, setTtsSuppressed] = useState(false);

  const wakeWord = useWakeWord({
    onCommand: useCallback(
      (cmd: string) => {
        if (cmd.trim()) handleTranscriptRef.current(cmd);
      },
      []
    ),
    enabled: ready,
    suppressed: ttsSuppressed || uiState === "submitting",
  });

  const handleTranscriptRef = useRef<(text: string) => void>(() => {});

  const handleTranscript = useCallback(
    async (text: string) => {
      setUiState("submitting");
      setErrorMessage(null);
      setLastAction(null);
      setStreamMessage("Understanding your request...");
      try {
        const result = await logWorkoutStreamed(text, (msg) => setStreamMessage(msg));
        setLastAction(result);
        setUiState("idle");
        setStreamMessage("");
        if (result.tts_audio_b64) {
          tts.speakFromBase64(result.tts_audio_b64);
        } else if (result.message) {
          tts.speak(result.message);
        }
        await loadWorkouts();
      } catch (err) {
        setUiState("error");
        setStreamMessage("");
        setErrorMessage(err instanceof Error ? err.message : "Something went wrong.");
      }
    },
    [loadWorkouts, tts]
  );

  useEffect(() => {
    handleTranscriptRef.current = handleTranscript;
  }, [handleTranscript]);

  /**
   * Mobile voice path. The clip goes straight to the agent endpoint, which
   * transcribes and runs the agent on one connection — uploading the audio and
   * then sending the resulting text back up would cost an extra round-trip.
   */
  const handleAudio = useCallback(
    async (audio: Blob, filename: string) => {
      setUiState("submitting");
      setErrorMessage(null);
      setLastAction(null);
      setStreamMessage("Transcribing your voice...");
      try {
        const result = await logWorkoutFromAudioStreamed(
          audio,
          filename,
          (msg) => setStreamMessage(msg),
          (heard) => setStreamMessage(`"${heard}"`),
        );
        setLastAction(result);
        setUiState("idle");
        setStreamMessage("");
        if (result.tts_audio_b64) {
          tts.speakFromBase64(result.tts_audio_b64);
        } else if (result.message) {
          tts.speak(result.message);
        }
        await loadWorkouts();
      } catch (err) {
        setUiState("error");
        setStreamMessage("");
        setErrorMessage(err instanceof Error ? err.message : "Something went wrong.");
      }
    },
    [loadWorkouts, tts]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setCrudError(null);
      setWorkouts((prev) => prev.filter((w) => w.id !== id));
      try {
        await deleteWorkout(id);
      } catch (err) {
        setCrudError(err instanceof Error ? err.message : "Delete failed.");
        await loadWorkouts();
      }
    },
    [loadWorkouts]
  );

  const handleEditSave = useCallback(
    async (id: string, values: WorkoutFormValues) => {
      setCrudError(null);
      setEditingId(null);
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
        await loadWorkouts();
      } catch (err) {
        setCrudError(err instanceof Error ? err.message : "Update failed.");
        setEditingId(id);
        await loadWorkouts();
      }
    },
    [loadWorkouts]
  );

  const handleManualAdd = useCallback(
    async (values: WorkoutFormValues) => {
      setCrudError(null);
      manualFormKey.current += 1;
      setShowManualForm(false);
      setAddForDate(null);
      setManualSaving(true);

      const tempId = `pending-${Date.now()}`;
      // Local noon, matching the backend's anchor, so the optimistic row lands in
      // the same day group the server will confirm it into.
      const optimisticDate = values.date
        ? new Date(`${values.date}T12:00:00`).toISOString()
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
      setWorkouts((prev) => [optimistic, ...prev]);

      const payload: ManualWorkoutRequest = {
        exercise: values.exercise.trim(),
        sets: parseInt(values.sets, 10),
        reps: parseInt(values.reps, 10),
        weight: parseFloat(values.weight),
        weight_unit: values.weight_unit,
        notes: values.notes.trim() || undefined,
        logged_at: values.date || undefined,
        client_tz: clientTz(),
      };
      try {
        await addWorkoutManually(payload);
        await loadWorkouts();
      } catch (err) {
        setCrudError(err instanceof Error ? err.message : "Could not add workout.");
        setWorkouts((prev) => prev.filter((w) => w.id !== tempId));
        setShowManualForm(true);
        await loadWorkouts();
      } finally {
        setManualSaving(false);
      }
    },
    [loadWorkouts]
  );

  const handleSessionSave = useCallback(
    async (date: string, sessionType: string) => {
      if (!sessionType.trim()) return;
      setSessionSaving(true);
      setCrudError(null);
      try {
        await updateSession(date, sessionType.trim());
        setEditSessionDate(null);
        await loadWorkouts();
      } catch (err) {
        setCrudError(err instanceof Error ? err.message : "Could not save session.");
      } finally {
        setSessionSaving(false);
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
    <div className="flex justify-center items-start">
      {/* Left particle strip — sits right beside the content column */}
      <div className="hidden xl:block w-32 flex-shrink-0 sticky top-12 self-start h-[calc(100vh-3rem)] overflow-hidden opacity-40 pointer-events-none">
        <ParticleTextEffect
          words={GYM_WORDS}
          canvasWidth={128}
          canvasHeight={900}
          fontSize="bold 32px Arial"
          className="w-full"
        />
      </div>

    <main className="flex-1 max-w-3xl px-4 py-8 relative z-10">
      {/* Header */}
      <div className="flex justify-between items-center mb-1">
        <h1 className="text-3xl font-bold text-violet-50 m-0">Workouts</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          className="text-white/50 hover:text-white text-sm"
        >
          Sign out
        </Button>
      </div>
      {userEmail && (
        <p className="text-violet-300/60 text-sm mt-1 mb-8">{userEmail}</p>
      )}
      {!userEmail && (
        <p className="text-violet-200/60 mt-0 mb-8">Speak or type your workout to log it instantly.</p>
      )}

      {/* Voice / text input card */}
      <section aria-label="Log a workout" className="glass p-5 mb-8">
        <VoiceInput
          onTranscript={handleTranscript}
          onAudio={handleAudio}
          disabled={uiState === "submitting"}
          onListenStart={wakeWord.pause}
          onListenEnd={wakeWord.resume}
        />

        {uiState === "submitting" && (
          <p className="text-white/50 mt-3 mb-0 text-sm animate-pulse">
            {streamMessage || "Parsing and saving your workout..."}
          </p>
        )}
        {uiState === "error" && errorMessage && (
          <p role="alert" className="text-red-400 mt-3 mb-0 text-sm">{errorMessage}</p>
        )}
        {lastAction && uiState === "idle" && <ActionCard action={lastAction} />}
      </section>

      {/* Workout history */}
      <section aria-label="Workout history">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-violet-100 m-0">Recent Workouts</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setShowManualForm((v) => !v); setEditingId(null); }}
            className={cn(
              "text-sm",
              showManualForm ? "text-white/40 hover:text-white/60" : "text-blue-300 hover:text-blue-200"
            )}
          >
            {showManualForm ? "Cancel" : "+ Add manually"}
          </Button>
        </div>

        {showManualForm && (
          <div className="glass-light p-4 mb-5">
            <p className="m-0 mb-2 font-semibold text-sm text-white/70">Add workout manually</p>
            <WorkoutForm
              key={manualFormKey.current}
              initial={blankForm()}
              onSave={handleManualAdd}
              onCancel={() => setShowManualForm(false)}
              saving={manualSaving}
            />
          </div>
        )}

        {/* Week navigator */}
        {(() => {
          const { label } = getWeekBounds(weekOffset);
          return (
            <div className="flex items-center gap-2 mb-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setWeekOffset((w) => w - 1)}
                className="text-white/50 hover:text-white text-sm"
              >
                ← Prev
              </Button>
              <span className="text-sm font-semibold text-white/70 flex-1 text-center">{label}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setWeekOffset((w) => w + 1)}
                disabled={weekOffset === 0}
                className="text-white/50 hover:text-white text-sm disabled:opacity-30"
              >
                Next →
              </Button>
            </div>
          );
        })()}

        {crudError && (
          <p role="alert" className="text-red-400 mb-3 text-sm">{crudError}</p>
        )}
        {historyError && (
          <p role="alert" className="text-yellow-400 mb-3">Could not load workout history. Is the backend running?</p>
        )}

        {!historyError && (() => {
          const { start, end } = getWeekBounds(weekOffset);
          const weekGroups = groupByDay(workouts, sessions).filter(
            (g) => g.date >= start && g.date <= end
          );
          return weekGroups.length === 0 ? (
            <p className="text-white/30">No workouts this week.</p>
          ) : (
            <div className="flex flex-col gap-5">
              {weekGroups.map((group) => (
                <div key={group.date}>
                  {/* Day header */}
                  <div className="glass flex items-center justify-between px-3 py-2 mb-2 rounded-xl">
                    <span className="text-sm font-semibold text-white/70 uppercase tracking-wide">
                      {group.label}
                    </span>
                    <div className="flex items-center gap-2">
                      {editSessionDate === group.date ? (
                        <form
                          onSubmit={(e) => { e.preventDefault(); handleSessionSave(group.date, editSessionInput); }}
                          className="flex gap-1 items-center"
                        >
                          <Input
                            autoFocus
                            value={editSessionInput}
                            onChange={(e) => setEditSessionInput(e.target.value)}
                            placeholder="push, legs, chest…"
                            disabled={sessionSaving}
                            className="glass-input py-0.5 px-2 text-xs h-6 w-32"
                          />
                          <button type="submit" disabled={sessionSaving || !editSessionInput.trim()}
                            className="text-[0.65rem] text-blue-300 bg-transparent border-none cursor-pointer px-1">
                            {sessionSaving ? "…" : "Save"}
                          </button>
                          <button type="button" onClick={() => setEditSessionDate(null)} disabled={sessionSaving}
                            className="text-[0.65rem] text-white/30 bg-transparent border-none cursor-pointer px-1">
                            Cancel
                          </button>
                        </form>
                      ) : group.session ? (
                        <button
                          onClick={() => { setEditSessionDate(group.date); setEditSessionInput(group.session!.session_type); }}
                          title="Edit session"
                          className="text-xs font-semibold bg-blue-500/20 text-blue-200 border border-blue-400/40 px-2.5 py-0.5 rounded-full capitalize cursor-pointer hover:bg-blue-500/30 transition-colors"
                        >
                          {group.session.session_type} ✎
                        </button>
                      ) : (
                        <button
                          onClick={() => { setEditSessionDate(group.date); setEditSessionInput(""); }}
                          title="Set session type"
                          className="text-xs text-white/30 bg-transparent border-none cursor-pointer hover:text-white/60 transition-colors"
                        >
                          + session
                        </button>
                      )}
                      <button
                        onClick={() => setAddForDate(addForDate === group.date ? null : group.date)}
                        title="Add workout for this day"
                        className={cn(
                          "text-base font-bold bg-transparent border-none cursor-pointer leading-none px-1 transition-colors",
                          addForDate === group.date ? "text-white/40" : "text-blue-300 hover:text-blue-200"
                        )}
                      >
                        {addForDate === group.date ? "✕" : "+"}
                      </button>
                    </div>
                  </div>

                  {/* Per-date manual-add form */}
                  {addForDate === group.date && (
                    <div className="glass-light p-4 mb-3">
                      <p className="m-0 mb-1 font-semibold text-xs text-white/60">
                        Add workout — {group.label}
                      </p>
                      <WorkoutForm
                        key={`${manualFormKey.current}-${group.date}`}
                        initial={blankForm("", group.date)}
                        onSave={handleManualAdd}
                        onCancel={() => setAddForDate(null)}
                        saving={manualSaving}
                      />
                    </div>
                  )}

                  {/* Workout cards */}
                  <ul className="list-none p-0 m-0 flex flex-col gap-2">
                    {group.workouts.map((w) => (
                      <li
                        key={w.id}
                        className={cn(
                          "p-4 hover:brightness-110 transition-all",
                          w.is_personal_record ? "glass-pr" : "glass"
                        )}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={cn(
                                "font-semibold capitalize",
                                w.is_personal_record ? "text-amber-200 text-base" : "text-violet-100"
                              )}>{w.exercise}</span>
                              <span className="text-violet-200/70 text-sm">
                                {w.sets}&times;{w.reps} @ {w.weight} {w.weight_unit}
                              </span>
                              {w.is_personal_record && (
                                <span className="inline-flex items-center gap-1 bg-gradient-to-r from-yellow-400 to-amber-500 text-black font-extrabold text-xs px-3 py-1 rounded-full shadow-[0_0_14px_rgba(251,191,36,0.7)] tracking-wide">
                                  🏆 PR
                                </span>
                              )}
                            </div>
                            {w.notes && editingId !== w.id && (
                              <p className="text-sm text-white/40 mt-1 mb-0">{w.notes}</p>
                            )}
                            {w.muscle_targets.length > 0 && editingId !== w.id && (
                              <div className="mt-2 flex gap-1 flex-wrap">
                                {w.muscle_targets.filter((t) => t.role === "primary").map((t) => (
                                  <span
                                    key={t.muscle_group}
                                    title={t.specific_muscles.join(", ")}
                                    className="text-[0.65rem] bg-green-500/15 text-green-300 border border-green-500/25 px-1.5 py-0.5 rounded-full cursor-default"
                                  >
                                    {t.muscle_group}
                                  </span>
                                ))}
                                {w.muscle_targets.filter((t) => t.role === "secondary").map((t) => (
                                  <span
                                    key={t.muscle_group}
                                    title={t.specific_muscles.join(", ")}
                                    className="text-[0.65rem] bg-slate-500/15 text-slate-300 border border-slate-500/25 px-1.5 py-0.5 rounded-full cursor-default"
                                  >
                                    {t.muscle_group}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-1 flex-shrink-0">
                            <time dateTime={w.logged_at} className="text-xs text-white/30 whitespace-nowrap">
                              {new Date(w.logged_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                            </time>
                            <button
                              aria-label={`Edit ${w.exercise}`}
                              onClick={() => setEditingId(editingId === w.id ? null : w.id)}
                              title="Edit"
                              className={cn(
                                "bg-transparent border-none cursor-pointer text-sm px-1.5 py-0.5 leading-none transition-colors rounded",
                                editingId === w.id ? "text-blue-300" : "text-white/30 hover:text-white/70"
                              )}
                            >
                              ✎
                            </button>
                            <button
                              aria-label={`Delete ${w.exercise}`}
                              onClick={() => handleDelete(w.id)}
                              disabled={deletingId === w.id}
                              title="Delete"
                              className="bg-transparent border-none cursor-pointer text-red-400/70 hover:text-red-400 text-sm px-1.5 py-0.5 leading-none transition-colors rounded disabled:opacity-40"
                            >
                              ✕
                            </button>
                          </div>
                        </div>

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
          );
        })()}
      </section>

      <WakeWordIndicator
        isListening={wakeWord.isListening}
        isActivated={wakeWord.isActivated}
        interimText={wakeWord.interimText}
        supported={wakeWord.supported}
        error={wakeWord.error}
        isSpeaking={tts.isSpeaking}
      />
    </main>

      {/* Right particle strip — sits right beside the content column */}
      <div className="hidden xl:block w-32 flex-shrink-0 sticky top-12 self-start h-[calc(100vh-3rem)] overflow-hidden opacity-40 pointer-events-none">
        <ParticleTextEffect
          words={[...GYM_WORDS].reverse()}
          canvasWidth={128}
          canvasHeight={900}
          fontSize="bold 32px Arial"
          className="w-full"
        />
      </div>
    </div>
  );
}
