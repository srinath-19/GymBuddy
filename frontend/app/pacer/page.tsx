"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { sendChat, ChatResponse, PacerAPIResponse } from "@/lib/chat-api";
import { pacerSetDone, pacerSkip, pacerModifyPlan, PacerManualAction } from "@/lib/pacer-api";
import WorkoutPacer from "@/components/WorkoutPacer";
import WakeWordIndicator from "@/components/WakeWordIndicator";
import VoiceInput from "@/components/VoiceInput";
import type { VoiceInputHandle } from "@/components/VoiceInput";
import { useWakeWord } from "@/lib/useWakeWord";
import { useTTS } from "@/lib/useTTS";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface UserMessage {
  role: "user";
  text: string;
}

interface AssistantMessage {
  role: "assistant";
  pacer?: PacerAPIResponse;
  text: string;
}

type ThreadMessage = UserMessage | AssistantMessage;

export default function PacerPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pacerConvId, setPacerConvId] = useState<string | null>(null);

  const [latestPhase, setLatestPhase] = useState<string | null>(null);
  const [latestRestSeconds, setLatestRestSeconds] = useState<number | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const voiceInputRef = useRef<VoiceInputHandle | null>(null);
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
            const saved = sessionStorage.getItem("gymbuddy:pacer");
            if (saved) {
              const { thread: t, pacerConvId: id } = JSON.parse(saved) as { thread: ThreadMessage[]; pacerConvId: string | null };
              if (t?.length) setThread(t);
              if (id) setPacerConvId(id);
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
      sessionStorage.setItem("gymbuddy:pacer", JSON.stringify({ thread, pacerConvId }));
    } catch { /* storage full */ }
  }, [thread, pacerConvId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread, loading]);

  useEffect(() => {
    if (latestPhase !== "resting" || !latestRestSeconds || latestRestSeconds <= 0) return;
    const timerId = setTimeout(() => {
      voiceInputRef.current?.startListening();
    }, (latestRestSeconds + 1) * 1000);
    return () => clearTimeout(timerId);
  }, [latestPhase, latestRestSeconds]);

  const handleTranscript = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      setLoading(true);
      setError(null);

      setThread((prev) => [...prev, { role: "user", text }]);

      try {
        const result: ChatResponse = await sendChat({
          text,
          pacer_conversation_id: pacerConvId,
        });

        if (result.pacer) {
          setPacerConvId(result.pacer.conversation_id);
          setLatestPhase(result.pacer.phase);
          setLatestRestSeconds(result.pacer.rest_seconds);
        }

        const assistantMsg: AssistantMessage = {
          role: "assistant",
          pacer: result.pacer ?? undefined,
          text:
            result.pacer?.message ??
            result.coach?.response.message ??
            result.workout?.message ??
            "",
        };
        setThread((prev) => [...prev, assistantMsg]);

        if (result.tts_audio_b64) {
          tts.speakFromBase64(result.tts_audio_b64);
        } else {
          const speakText = result.pacer?.message ?? result.workout?.message ?? "";
          if (speakText) tts.speak(speakText);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setLoading(false);
      }
    },
    [pacerConvId, tts]
  );

  useEffect(() => {
    handleTranscriptRef.current = handleTranscript;
  }, [handleTranscript]);

  const handleManualAction = useCallback(
    async (action: PacerManualAction) => {
      if (!pacerConvId) return;
      setLoading(true);
      setError(null);

      try {
        let pacer: PacerAPIResponse;

        if (action.type === "set-done") {
          pacer = await pacerSetDone(pacerConvId, {
            reps: action.reps,
            weight: action.weight,
            weight_unit: action.weight_unit,
          });
        } else if (action.type === "skip") {
          pacer = await pacerSkip(pacerConvId);
        } else if (action.type === "plan-remove") {
          pacer = await pacerModifyPlan(pacerConvId, { action: "remove", exercise_name: action.exercise_name });
        } else if (action.type === "plan-add") {
          pacer = await pacerModifyPlan(pacerConvId, { action: "add", exercise_name: action.exercise_name, target_sets: action.target_sets, target_reps: action.target_reps });
        } else if (action.type === "plan-change") {
          pacer = await pacerModifyPlan(pacerConvId, { action: "change", exercise_name: action.exercise_name, target_sets: action.target_sets, target_reps: action.target_reps });
        } else {
          pacer = await pacerModifyPlan(pacerConvId, { action: "swap", exercise_name: action.exercise_name, replacement_name: action.replacement_name, target_sets: action.target_sets, target_reps: action.target_reps });
        }

        setLatestPhase(pacer.phase);
        setLatestRestSeconds(pacer.rest_seconds);
        setThread((prev) => [...prev, { role: "assistant" as const, pacer, text: pacer.message }]);
        if (pacer.tts_audio_b64) {
          tts.speakFromBase64(pacer.tts_audio_b64);
        } else if (pacer.message) {
          tts.speak(pacer.message);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setLoading(false);
      }
    },
    [pacerConvId, tts]
  );

  function handleEndSession() {
    handleTranscript("end session");
  }

  function handleClear() {
    setThread([]);
    setPacerConvId(null);
    setError(null);
    setLatestPhase(null);
    setLatestRestSeconds(null);
    try { sessionStorage.removeItem("gymbuddy:pacer"); } catch { /* ignore */ }
  }

  if (!ready) return null;

  const latestPacer = [...thread].reverse().find(
    (m): m is AssistantMessage => m.role === "assistant" && !!m.pacer
  )?.pacer;

  const sessionActive = latestPacer && latestPacer.phase !== "done" && latestPacer.total_exercises > 0;
  const sessionDone = latestPacer?.phase === "done";

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-3xl font-bold text-white m-0">Pacer</h1>
          <p className="text-white/40 text-sm mt-1 mb-0">
            Voice-guided workouts. Say &quot;start my push workout&quot; to begin.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {sessionActive && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleEndSession}
              disabled={loading}
              className="text-red-400 border-red-400/40 hover:bg-red-400/10 text-sm font-semibold disabled:opacity-50"
            >
              End Session
            </Button>
          )}
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
      </div>

      {/* Message thread */}
      {thread.length > 0 && (
        <div className="flex flex-col gap-4 mb-6">
          {thread.map((msg, i) => {
            if (msg.role === "user") {
              return (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] bg-white/10 backdrop-blur-sm border border-white/15 text-white rounded-[0.75rem_0.75rem_0.125rem_0.75rem] px-3.5 py-2.5">
                    <p className="m-0 text-sm">{msg.text}</p>
                  </div>
                </div>
              );
            }

            return (
              <div key={i} className="flex flex-col gap-1">
                <span className="text-[0.7rem] text-white/40 font-semibold uppercase tracking-widest">
                  Pacer
                </span>
                <div className={cn(
                  "glass rounded-[0.125rem_0.75rem_0.75rem_0.75rem] p-4",
                  msg.pacer?.phase === "active" && "border-green-400/30",
                  msg.pacer?.phase === "resting" && "border-yellow-400/30",
                  msg.pacer?.phase === "planning" && "border-blue-400/30",
                  msg.pacer?.phase === "done" && "border-white/10"
                )}>
                  {msg.pacer ? (
                    <WorkoutPacer response={msg.pacer} onAction={handleManualAction} />
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
        <div className="text-center py-12 px-4">
          <p className="text-5xl mb-4">🏋️</p>
          <p className="text-base font-semibold text-white/70 mb-1">Ready to train?</p>
          <p className="text-sm text-white/40 m-0">
            Say &quot;start my push workout&quot; to get a guided plan, or &quot;done&quot; after each set.
          </p>

          <div className="flex flex-wrap gap-2 justify-center mt-6">
            {["push", "pull", "legs", "chest", "back", "arms"].map((stype) => (
              <button
                key={stype}
                onClick={() => handleTranscript(`start my ${stype} workout`)}
                disabled={loading}
                className="text-sm font-semibold px-4 py-1.5 rounded-full border border-white/20 bg-white/5 text-white/60 hover:bg-white/15 hover:text-white hover:border-white/40 transition-all capitalize cursor-pointer disabled:opacity-40"
              >
                {stype}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-red-400 text-sm mb-3">{error}</p>
      )}

      {/* Session done summary */}
      {sessionDone && latestPacer && (
        <div className="glass p-5 mb-4 text-center">
          <p className="m-0 mb-1 text-base font-bold text-white">Session Complete 🎉</p>
          <p className="m-0 text-sm text-white/50">
            {latestPacer.completed_exercises} exercise{latestPacer.completed_exercises !== 1 ? "s" : ""} logged
            {latestPacer.session_type ? ` • ${latestPacer.session_type} day` : ""}
          </p>
          <Button
            onClick={handleClear}
            variant="outline"
            size="sm"
            className="mt-3 border-white/20 text-white/60 hover:text-white hover:border-white/40 bg-transparent"
          >
            Start New Session
          </Button>
        </div>
      )}

      {/* Sticky voice input */}
      <div className={cn(
        "sticky bottom-0 pt-3",
        thread.length > 0 && "border-t border-white/10"
      )}>
        <div className="glass p-4">
          <VoiceInput
            ref={voiceInputRef}
            onTranscript={handleTranscript}
            disabled={loading}
            label="Or type a command:"
            placeholder="'start my push workout', 'done', 'done 10 at 155'..."
            submitLabel="Send"
            onListenStart={wakeWord.pause}
            onListenEnd={wakeWord.resume}
          />
        </div>
      </div>

      <WakeWordIndicator
        isListening={wakeWord.isListening}
        isActivated={wakeWord.isActivated}
        interimText={wakeWord.interimText}
        supported={wakeWord.supported}
        error={wakeWord.error}
        isSpeaking={tts.isSpeaking}
      />
    </main>
  );
}
