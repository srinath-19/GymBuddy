"use client";

import { useEffect, useRef, useState } from "react";
import type { PacerAPIResponse, PlanItem } from "@/lib/chat-api";
import type { PacerManualAction } from "@/lib/pacer-api";
import type { MuscleTargetResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

interface WorkoutPacerProps {
  response: PacerAPIResponse;
  onAction: (action: PacerManualAction) => void;
}

const phaseStyle: Record<string, { badge: string; label: string }> = {
  planning: { badge: "bg-blue-500/20 text-blue-200 border-blue-400/40",   label: "Planning" },
  active:   { badge: "bg-green-500/20 text-green-200 border-green-400/40", label: "Active"   },
  resting:  { badge: "bg-yellow-500/20 text-yellow-200 border-yellow-400/40", label: "Resting" },
  done:     { badge: "bg-white/10 text-white/50 border-white/20",          label: "Done"     },
};

// ---------------------------------------------------------------------------
// Inline plan editor
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
      <p className="m-0 mb-2 text-xs font-bold text-violet-300/60 uppercase tracking-widest">Workout Plan</p>
      <div className="flex flex-col gap-1">
        {plan.map((item, i) => (
          <div
            key={i}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-opacity",
              item.finalized
                ? "bg-green-500/10 border-green-500/25 opacity-60"
                : "bg-white/5 border-white/10"
            )}
          >
            <span className="text-xs text-violet-300/50 w-4 text-center flex-shrink-0">
              {item.finalized ? "✓" : i + 1}
            </span>
            <span className="flex-1 text-sm text-violet-100 capitalize">{item.name}</span>

            {!item.finalized && editIdx === i ? (
              <div className="flex items-center gap-1">
                <input
                  type="number" min={1} max={20} value={editSets}
                  onChange={(e) => setEditSets(e.target.value)}
                  className="glass-input w-10 text-xs text-center rounded py-0.5 px-1"
                />
                <span className="text-xs text-violet-300/50">×</span>
                <input
                  type="number" min={1} max={50} value={editReps}
                  onChange={(e) => setEditReps(e.target.value)}
                  className="glass-input w-10 text-xs text-center rounded py-0.5 px-1"
                />
                <button onClick={() => commitEdit(item)} className="text-xs text-green-300 bg-green-500/20 border border-green-500/30 px-1.5 py-0.5 rounded cursor-pointer">✓</button>
                <button onClick={() => setEditIdx(null)} className="text-xs text-white/40 bg-white/5 border border-white/10 px-1.5 py-0.5 rounded cursor-pointer">✕</button>
              </div>
            ) : (
              <>
                <span
                  onClick={() => !item.finalized && openEdit(i, item)}
                  title={item.finalized ? undefined : "Click to edit sets/reps"}
                  className={cn(
                    "text-xs text-violet-200/60 whitespace-nowrap px-1.5 py-0.5 rounded",
                    !item.finalized && "border border-dashed border-white/20 cursor-pointer hover:border-white/40"
                  )}
                >
                  {item.target_sets}×{item.target_reps}
                </span>
                {!item.finalized && (
                  <button
                    onClick={() => onAction({ type: "plan-remove", exercise_name: item.name })}
                    title="Remove"
                    className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-1.5 py-0.5 rounded cursor-pointer hover:bg-red-500/20"
                  >
                    ✕
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-2 mt-2">
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
          className="glass-input flex-1 text-sm rounded-lg px-2 py-1"
        />
        <button
          onClick={() => {
            if (addName.trim()) {
              onAction({ type: "plan-add", exercise_name: addName.trim() });
              setAddName("");
            }
          }}
          className="text-xs font-semibold text-blue-200 bg-blue-500/20 border border-blue-400/30 px-3 py-1 rounded-lg cursor-pointer hover:bg-blue-500/30"
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
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => onAction({ type: "set-done" })}
          className="text-sm font-bold px-4 py-2 rounded-lg bg-green-500/20 border border-green-400/40 text-green-200 cursor-pointer hover:bg-green-500/30 transition-colors"
        >
          Set Done
        </button>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="text-sm font-semibold px-3 py-2 rounded-lg bg-white/8 border border-white/15 text-violet-200 cursor-pointer hover:bg-white/15 transition-colors"
        >
          Done with numbers…
        </button>
        {currentExercise && (
          <button
            onClick={() => onAction({ type: "skip" })}
            className="text-sm px-3 py-2 rounded-lg bg-transparent border border-white/10 text-white/40 cursor-pointer hover:text-white/60 hover:border-white/20 transition-colors"
          >
            Skip
          </button>
        )}
      </div>

      {showForm && (
        <div className="flex gap-2 items-center flex-wrap">
          <input
            type="number" placeholder="Weight (lbs)" value={weight}
            onChange={(e) => setWeight(e.target.value)}
            className="glass-input w-28 text-sm rounded-lg px-2 py-1"
          />
          <span className="text-xs text-violet-300/50">×</span>
          <input
            type="number" placeholder="Reps" value={reps}
            onChange={(e) => setReps(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitWithNumbers()}
            className="glass-input w-20 text-sm rounded-lg px-2 py-1"
          />
          <button onClick={submitWithNumbers} className="text-sm font-bold px-3 py-1 rounded-lg bg-green-500/20 border border-green-400/40 text-green-200 cursor-pointer hover:bg-green-500/30">Log</button>
          <button onClick={() => setShowForm(false)} className="text-sm px-3 py-1 rounded-lg border border-white/10 text-white/40 cursor-pointer hover:text-white/60 bg-transparent">Cancel</button>
        </div>
      )}
    </div>
  );
}

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

  const ps = phaseStyle[phase] ?? phaseStyle.planning;

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
        if (t === null || t <= 1) { clearInterval(id); return 0; }
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

  const hasProgress = total_exercises > 0;
  const progressPercent = hasProgress ? Math.round((completed_exercises / total_exercises) * 100) : 0;

  const planForEditor: PlanItem[] =
    current_plan.length > 0
      ? current_plan
      : suggested_exercises.map((name) => ({
          name, target_sets: 3, target_reps: 10, sets_done: 0, finalized: false,
        }));

  const showPlanEditor = planForEditor.length > 0 && phase !== "done";

  return (
    <div className="flex flex-col gap-4">
      {/* Progress bar */}
      {hasProgress && (
        <div className="flex items-center gap-2">
          {session_type && (
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-white/10 text-violet-200/70 uppercase tracking-widest">
              {session_type}
            </span>
          )}
          <div className="flex-1 flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${progressPercent}%`,
                  background: progressPercent === 100
                    ? "linear-gradient(90deg, #22c55e, #4ade80)"
                    : "linear-gradient(90deg, #6366f1, #818cf8)",
                }}
              />
            </div>
            <span className="text-xs text-violet-200/50 font-semibold whitespace-nowrap">
              {completed_exercises}/{total_exercises}
            </span>
          </div>
        </div>
      )}

      {/* Phase badge + current exercise */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs font-bold px-3 py-0.5 rounded-full border uppercase tracking-widest ${ps.badge}`}>
          {ps.label}
        </span>
        {current_exercise && (
          <span className="font-bold text-base text-violet-50">
            {current_exercise}
            {set_number != null && (
              <span className="font-normal text-violet-300/60 text-sm"> — set {set_number}</span>
            )}
          </span>
        )}
        {current_exercise_sets_total > 0 && phase !== "done" && (
          <span className="text-xs font-semibold text-violet-300/40 ml-auto">
            {current_exercise_sets_done}/{current_exercise_sets_total} sets
          </span>
        )}
      </div>

      {/* Message */}
      <p className="m-0 text-sm text-violet-100/85 leading-relaxed">{message}</p>

      {/* Active quick actions */}
      {phase === "active" && (
        <ActiveActions currentExercise={current_exercise} onAction={onAction} />
      )}

      {/* Rest timer */}
      {phase === "resting" && timeLeft !== null && (
        <div className={cn(
          "px-4 py-3 rounded-xl border text-center",
          restDone
            ? "bg-green-500/15 border-green-400/40"
            : "bg-yellow-500/15 border-yellow-400/40"
        )}>
          {restDone ? (
            <p className="m-0 font-bold text-lg text-green-200">Rest done — let&apos;s go!</p>
          ) : (
            <>
              <p className="m-0 mb-1 text-xs text-yellow-300/60 font-semibold uppercase tracking-widest">Rest</p>
              <p className="m-0 font-extrabold text-4xl text-yellow-200 tabular-nums">
                {minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`}
              </p>
            </>
          )}
        </div>
      )}

      {/* Plan editor */}
      {showPlanEditor && <PlanEditor plan={planForEditor} onAction={onAction} />}

      {/* Logged workout confirmation */}
      {logged_workout && (
        <div className={cn(
          "px-3 py-2.5 rounded-xl border flex items-center justify-between",
          logged_workout.is_personal_record
            ? "glass-pr"
            : "bg-green-500/10 border-green-500/25"
        )}>
          <div>
            <span className="text-xs font-semibold text-green-300/70 uppercase tracking-widest">Logged</span>
            <div className="mt-0.5">
              <span className="font-semibold text-sm text-violet-50 capitalize">{logged_workout.exercise}</span>
              <span className="text-xs text-violet-200/60 ml-1.5">
                {logged_workout.sets}×{logged_workout.reps} @ {logged_workout.weight} {logged_workout.weight_unit}
              </span>
            </div>
          </div>
          {logged_workout.is_personal_record && (
            <span className="inline-flex items-center gap-1 bg-gradient-to-r from-yellow-400 to-amber-500 text-black font-extrabold text-xs px-3 py-1 rounded-full shadow-[0_0_14px_rgba(251,191,36,0.7)] tracking-wide">
              🏆 PR
            </span>
          )}
        </div>
      )}

      {/* Muscle targets */}
      {logged_workout?.muscle_targets && logged_workout.muscle_targets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {logged_workout.muscle_targets.map((t: MuscleTargetResponse, i: number) => (
            <span key={i} className={cn(
              "text-xs px-2 py-0.5 rounded-full border",
              t.role === "primary"
                ? "bg-green-500/20 text-green-300 border-green-500/30"
                : "bg-slate-500/20 text-slate-300 border-slate-500/30"
            )}>
              {t.muscle_group}
            </span>
          ))}
        </div>
      )}

      {/* Done state */}
      {phase === "done" && (
        <div className="px-4 py-3 rounded-xl bg-green-500/15 border border-green-400/40 text-center">
          <p className="m-0 font-bold text-base text-green-200">Workout complete. Good work.</p>
          {hasProgress && (
            <p className="m-0 mt-1 text-sm text-violet-200/50">
              {completed_exercises} exercise{completed_exercises !== 1 ? "s" : ""} logged
            </p>
          )}
        </div>
      )}
    </div>
  );
}
