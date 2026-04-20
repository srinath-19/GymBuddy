"use client";

import { ExerciseCoachResponse } from "@/lib/coach-api";
import YouTubeEmbed from "./YouTubeEmbed";
import { Button } from "@/components/ui/button";

interface CoachResponseProps {
  response: ExerciseCoachResponse;
  onLogExercise: (name: string) => void;
}

const difficultyStyle: Record<string, string> = {
  beginner:     "bg-green-500/20 text-green-300 border-green-500/40",
  intermediate: "bg-yellow-500/20 text-yellow-300 border-yellow-500/40",
  advanced:     "bg-red-500/20 text-red-300 border-red-500/40",
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

  const diffClass = difficulty ? (difficultyStyle[difficulty.toLowerCase()] ?? "bg-white/10 text-white/70 border-white/20") : null;
  const primaryMuscles = muscles_targeted.filter((m) => m.role === "primary");
  const secondaryMuscles = muscles_targeted.filter((m) => m.role === "secondary");

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          {equipment_name && (
            <p className="m-0 text-xs text-violet-300/60 uppercase tracking-widest">
              {equipment_name}
            </p>
          )}
          {exercise_name && (
            <h3 className="m-0 text-lg font-bold text-violet-50">
              {exercise_name}
            </h3>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {diffClass && difficulty && (
            <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border capitalize ${diffClass}`}>
              {difficulty}
            </span>
          )}
          {exercise_name && (
            <Button
              size="sm"
              onClick={() => onLogExercise(exercise_name.toLowerCase())}
              className="bg-white/10 hover:bg-white/20 border border-white/20 text-violet-100 text-xs font-semibold"
            >
              Log This Exercise
            </Button>
          )}
        </div>
      </div>

      {/* Message */}
      {message && (
        <p className="m-0 text-sm text-violet-100/90 leading-relaxed">{message}</p>
      )}

      {/* Muscles */}
      {muscles_targeted.length > 0 && (
        <div>
          <p className="m-0 mb-1.5 text-xs font-semibold text-violet-300/60 uppercase tracking-widest">Muscles</p>
          <div className="flex gap-1.5 flex-wrap">
            {primaryMuscles.map((m) => (
              <span key={m.muscle_group} className="text-xs bg-green-500/20 text-green-300 border border-green-500/30 px-2 py-0.5 rounded-full">
                {m.muscle_group}
              </span>
            ))}
            {secondaryMuscles.map((m) => (
              <span key={m.muscle_group} className="text-xs bg-slate-500/20 text-slate-300 border border-slate-500/30 px-2 py-0.5 rounded-full">
                {m.muscle_group}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Instructions */}
      {instructions.length > 0 && (
        <div>
          <p className="m-0 mb-2 text-xs font-semibold text-violet-300/60 uppercase tracking-widest">How To</p>
          <ol className="m-0 pl-5 flex flex-col gap-1.5">
            {instructions.map((step, i) => (
              <li key={i} className="text-sm text-violet-100/85 leading-relaxed">{step}</li>
            ))}
          </ol>
        </div>
      )}

      {/* YouTube videos */}
      {videos.length > 0 && (
        <div className="flex flex-col gap-3">
          {videos.map((v) => (
            <div key={v.video_id}>
              <p className="m-0 mb-1.5 text-sm font-medium text-violet-200/80">{v.title}</p>
              <YouTubeEmbed videoId={v.video_id} title={v.title} />
            </div>
          ))}
        </div>
      )}

      {/* Common mistakes */}
      {common_mistakes.length > 0 && (
        <div>
          <p className="m-0 mb-2 text-xs font-semibold text-violet-300/60 uppercase tracking-widest">Common Mistakes</p>
          <ul className="m-0 pl-5 flex flex-col gap-1.5">
            {common_mistakes.map((m, i) => (
              <li key={i} className="text-sm text-violet-100/85 leading-relaxed">{m}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Tips */}
      {tips.length > 0 && (
        <div className="glass-light px-3 py-2.5 border-blue-400/30">
          {tips.map((tip, i) => (
            <p key={i} className={`text-sm text-blue-200/90 leading-relaxed ${i === 0 ? "m-0" : "m-0 mt-1"}`}>
              {tip}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
