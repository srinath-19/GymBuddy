"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { sendChat, ChatResponse } from "@/lib/chat-api";
import type { ExerciseCoachResponse } from "@/lib/coach-api";
import { resizeImageToBase64 } from "@/lib/coach-api";
import CoachResponse from "@/components/CoachResponse";
import CameraCapture from "@/components/CameraCapture";
import WakeWordIndicator from "@/components/WakeWordIndicator";
import VoiceInput from "@/components/VoiceInput";
import { addWorkoutManually, logWorkout, type AgentActionResponse } from "@/lib/api";
import { useWakeWord } from "@/lib/useWakeWord";
import { useTTS } from "@/lib/useTTS";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface UserMessage {
  role: "user";
  text: string;
  image?: string;
}

interface AssistantMessage {
  role: "assistant";
  agent_type: "workout" | "coach";
  workout?: AgentActionResponse;
  coach?: ExerciseCoachResponse;
  text: string;
}

type ThreadMessage = UserMessage | AssistantMessage;

export default function CoachPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const pendingImageRef = useRef<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [coachConvId, setCoachConvId] = useState<string | null>(null);

  const [logModal, setLogModal] = useState<{ exerciseName: string } | null>(null);
  const [logSets, setLogSets] = useState("3");
  const [logReps, setLogReps] = useState("10");
  const [logWeight, setLogWeight] = useState("135");
  const [logUnit, setLogUnit] = useState<"lbs" | "kg">("lbs");
  const [logSubmitting, setLogSubmitting] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const didRestoreRef = useRef(false);

  const [ttsSuppressed, setTtsSuppressed] = useState(false);
  const tts = useTTS({
    voice: "echo",
    onStart: () => setTtsSuppressed(true),
    onEnd: () => setTtsSuppressed(false),
  });

  const handleTranscriptRef = useRef<(text: string) => void>(() => {});
  const wakeWord = useWakeWord({
    onCommand: useCallback(
      (cmd: string) => {
        if (cmd.trim()) handleTranscriptRef.current(cmd);
      },
      []
    ),
    enabled: ready,
    suppressed: ttsSuppressed || loading,
  });

  useEffect(() => {
    createClient()
      .auth.getSession()
      .then(({ data }) => {
        if (!data.session) {
          router.replace("/login");
        } else {
          try {
            const saved = sessionStorage.getItem("gymbuddy:coach");
            if (saved) {
              const { thread: t, coachConvId: id } = JSON.parse(saved) as { thread: ThreadMessage[]; coachConvId: string | null };
              if (t?.length) setThread(t);
              if (id) setCoachConvId(id);
            }
          } catch { /* ignore */ }
          didRestoreRef.current = true;
          setReady(true);
        }
      });
  }, [router]);

  useEffect(() => {
    if (!didRestoreRef.current) return;
    try {
      const threadToSave = thread.map((msg) =>
        msg.role === "user" ? { ...msg, image: undefined } : msg
      );
      sessionStorage.setItem("gymbuddy:coach", JSON.stringify({ thread: threadToSave, coachConvId }));
    } catch { /* storage full */ }
  }, [thread, coachConvId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread, loading]);

  useEffect(() => {
    pendingImageRef.current = pendingImage;
  }, [pendingImage]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingImage(await resizeImageToBase64(file));
    e.target.value = "";
  }

  function handleCameraCapture(base64: string) {
    setPendingImage(base64);
    setShowCamera(false);
  }

  function handleLogExercise(exerciseName: string) {
    setLogSets("3"); setLogReps("10"); setLogWeight("135");
    setLogUnit("lbs"); setLogError(null); setLogSubmitting(false);
    setLogModal({ exerciseName });
  }

  async function handleLogSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!logModal) return;
    const sets = parseInt(logSets, 10);
    const reps = parseInt(logReps, 10);
    const weight = parseFloat(logWeight);
    if (isNaN(sets) || sets < 1 || isNaN(reps) || reps < 1 || isNaN(weight) || weight < 0) {
      setLogError("Please enter valid numbers for sets, reps, and weight.");
      return;
    }
    setLogSubmitting(true);
    setLogError(null);
    try {
      await addWorkoutManually({ exercise: logModal.exerciseName, sets, reps, weight, weight_unit: logUnit });
      setThread((prev) => [
        ...prev,
        { role: "assistant", agent_type: "coach", text: `Logged ${logModal.exerciseName} ${sets}×${reps} @ ${weight} ${logUnit}` } as AssistantMessage,
      ]);
      setLogModal(null);
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Failed to log workout.");
    } finally {
      setLogSubmitting(false);
    }
  }

  const submitMessage = useCallback(
    async (userText: string, img: string | null) => {
      if (!userText && !img) return;
      setLoading(true);
      setError(null);

      setThread((prev) => [
        ...prev,
        { role: "user", text: userText, image: img ?? undefined },
      ]);

      try {
        const result: ChatResponse = await sendChat({
          text: userText,
          image_base64: img ?? undefined,
          coach_conversation_id: coachConvId,
        });

        if (result.agent_type === "coach" && result.coach) {
          setCoachConvId(result.coach.conversation_id);
        }

        const assistantMsg: AssistantMessage = {
          role: "assistant",
          agent_type: result.agent_type === "pacer" ? "coach" : result.agent_type as "workout" | "coach",
          workout: result.workout ?? undefined,
          coach: result.coach?.response,
          text:
            result.coach?.response.message ??
            result.workout?.message ??
            "",
        };
        setThread((prev) => [...prev, assistantMsg]);

        if (result.tts_audio_b64) {
          tts.speakFromBase64(result.tts_audio_b64);
        } else {
          const speakText = result.coach?.response.message ?? result.workout?.message ?? "";
          if (speakText) tts.speak(speakText);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setLoading(false);
      }
    },
    [coachConvId, tts]
  );

  const handleTranscript = useCallback(
    (voiceText: string) => {
      const img = pendingImageRef.current;
      setPendingImage(null);
      const trimmed = voiceText.trim();
      const LOG_INTENT = /\b(log\s+this|log\s+it|record\s+this|save\s+this|(?:i\s+(?:just\s+)?|just\s+)did\s+this(?:\s+exercise)?|done\s+this(?:\s+exercise)?)\b/i;

      if (LOG_INTENT.test(trimmed)) {
        let lastExercise: string | null = null;
        for (let i = thread.length - 1; i >= 0; i--) {
          const msg = thread[i];
          if (msg.role === "assistant" && msg.coach?.exercise_name) {
            lastExercise = msg.coach.exercise_name.toLowerCase();
            break;
          }
        }
        if (lastExercise) {
          const enriched = `Log ${lastExercise} ${trimmed.replace(LOG_INTENT, "").trim()}`.trim();
          setThread((prev) => [...prev, { role: "user", text: trimmed } as UserMessage]);
          setLoading(true);
          setError(null);
          logWorkout(enriched)
            .then((result) => {
              setThread((prev) => [
                ...prev,
                { role: "assistant", agent_type: "coach", text: result.message } as AssistantMessage,
              ]);
            })
            .catch((err) => setError(err instanceof Error ? err.message : "Failed to log workout."))
            .finally(() => setLoading(false));
          return;
        }
      }
      const finalText = trimmed || (img ? "What is this? How do I use it?" : "");
      submitMessage(finalText, img);
    },
    [submitMessage, thread]
  );

  useEffect(() => {
    handleTranscriptRef.current = handleTranscript;
  }, [handleTranscript]);

  function handleClear() {
    setThread([]);
    setCoachConvId(null);
    setError(null);
    setPendingImage(null);
    try { sessionStorage.removeItem("gymbuddy:coach"); } catch { /* ignore */ }
  }

  if (!ready) return null;

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-3xl font-bold text-white m-0">Coach</h1>
          <p className="text-white/40 text-sm mt-1 mb-0">
            Ask about exercise form, identify equipment, or get technique guidance.
          </p>
        </div>
        {thread.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            className="text-white/40 hover:text-white text-sm"
          >
            Clear
          </Button>
        )}
      </div>

      {/* Message thread */}
      {thread.length > 0 && (
        <div className="flex flex-col gap-4 mb-6">
          {thread.map((msg, i) => {
            if (msg.role === "user") {
              return (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] bg-white/10 backdrop-blur-sm border border-white/15 text-white rounded-[0.75rem_0.75rem_0.125rem_0.75rem] px-3.5 py-2.5">
                    {msg.image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={msg.image}
                        alt="uploaded"
                        className="w-full max-h-40 object-cover rounded-md mb-2"
                      />
                    )}
                    {msg.text && <p className="m-0 text-sm">{msg.text}</p>}
                  </div>
                </div>
              );
            }

            return (
              <div key={i} className="flex flex-col gap-1">
                <span className="text-[0.7rem] text-white/40 font-semibold uppercase tracking-widest">
                  Coach
                </span>
                <div className="glass rounded-[0.125rem_0.75rem_0.75rem_0.75rem] p-4">
                  {msg.coach ? (
                    <CoachResponse response={msg.coach} onLogExercise={handleLogExercise} />
                  ) : (
                    <p className="m-0 text-sm text-white/80">{msg.text}</p>
                  )}
                </div>
              </div>
            );
          })}

          {loading && (
            <div className="flex flex-col gap-1">
              <span className="text-[0.7rem] text-white/40 font-semibold uppercase tracking-widest">
                Thinking...
              </span>
              <div className="glass rounded-[0.125rem_0.75rem_0.75rem_0.75rem] p-4 text-white/30 text-sm animate-pulse">
                ···
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      )}

      {/* Empty state */}
      {thread.length === 0 && !loading && (
        <div className="text-center py-12 px-4 text-white/30">
          <p className="text-base m-0">
            Ask about exercise form, identify equipment from a photo, or get guidance on a specific muscle group.
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-red-400 text-sm mb-3">{error}</p>
      )}

      {/* Sticky input area */}
      <div className={cn(
        "sticky bottom-0 pt-3",
        thread.length > 0 && "border-t border-white/10"
      )}>
        <div className="glass p-4 flex flex-col gap-3">
          {/* Pending image preview */}
          {pendingImage && (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={pendingImage}
                alt="preview"
                className="w-full max-h-32 object-cover rounded-lg border border-white/15"
              />
              <button
                type="button"
                onClick={() => setPendingImage(null)}
                className="absolute top-1.5 right-1.5 bg-black/60 text-white border-none rounded-full w-6 h-6 cursor-pointer text-xs flex items-center justify-center hover:bg-black/80 transition-colors"
              >
                ✕
              </button>
            </div>
          )}

          {/* Image buttons */}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowCamera(true)}
              title="Use camera"
              className="border-white/20 text-white/60 hover:text-white hover:border-white/40 bg-transparent"
            >
              📷
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              title="Upload image"
              className="border-white/20 text-white/60 hover:text-white hover:border-white/40 bg-transparent"
            >
              🖼
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          <VoiceInput
            onTranscript={handleTranscript}
            disabled={loading}
            label="Or type your question:"
            placeholder="Ask about form, technique, or equipment..."
            submitLabel="Send"
            onListenStart={wakeWord.pause}
            onListenEnd={wakeWord.resume}
          />
        </div>
      </div>

      {showCamera && (
        <CameraCapture
          onCapture={handleCameraCapture}
          onClose={() => setShowCamera(false)}
        />
      )}

      {/* Log workout modal */}
      {logModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[1000] p-4">
          <div className="glass w-full max-w-[400px] shadow-2xl">
            <div className="flex justify-between items-center px-4 py-3 border-b border-white/10">
              <span className="font-bold text-base text-white">Log Exercise</span>
              <button onClick={() => setLogModal(null)} className="bg-transparent border-none cursor-pointer text-lg text-white/40 hover:text-white transition-colors">✕</button>
            </div>
            <form onSubmit={handleLogSubmit} className="p-4 flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-white/50 uppercase tracking-widest mb-1">Exercise</label>
                <Input type="text" value={logModal.exerciseName} readOnly className="glass-input opacity-70" />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-white/50 uppercase tracking-widest mb-1">Sets</label>
                  <Input type="number" min="1" max="99" value={logSets} onChange={(e) => setLogSets(e.target.value)} className="glass-input" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-white/50 uppercase tracking-widest mb-1">Reps</label>
                  <Input type="number" min="1" max="999" value={logReps} onChange={(e) => setLogReps(e.target.value)} className="glass-input" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-white/50 uppercase tracking-widest mb-1">Weight</label>
                <div className="flex gap-2">
                  <Input type="number" min="0" step="0.5" value={logWeight} onChange={(e) => setLogWeight(e.target.value)} className="glass-input flex-1" />
                  <select value={logUnit} onChange={(e) => setLogUnit(e.target.value as "lbs" | "kg")} className="glass-input rounded-lg px-2 py-1 text-sm w-16">
                    <option value="lbs">lbs</option>
                    <option value="kg">kg</option>
                  </select>
                </div>
              </div>
              {logError && <p role="alert" className="m-0 text-sm text-red-400">{logError}</p>}
              <Button
                type="submit"
                disabled={logSubmitting}
                className="w-full bg-white/10 hover:bg-white/20 border border-white/20 text-white font-semibold"
              >
                {logSubmitting ? "Logging..." : "Log Workout"}
              </Button>
            </form>
          </div>
        </div>
      )}

      <WakeWordIndicator
        isListening={wakeWord.isListening}
        isActivated={wakeWord.isActivated}
        interimText={wakeWord.interimText}
        supported={wakeWord.supported}
        isSpeaking={tts.isSpeaking}
      />
    </main>
  );
}
