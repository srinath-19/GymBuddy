"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { sendChat, ChatResponse, PacerAPIResponse } from "@/lib/chat-api";
import { pacerSetDone, pacerSkip, pacerModifyPlan, PacerManualAction } from "@/lib/pacer-api";
import WorkoutPacer from "@/components/WorkoutPacer";
import VoiceInput from "@/components/VoiceInput";
import type { VoiceInputHandle } from "@/components/VoiceInput";

// ---------------------------------------------------------------------------
// Message thread types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pacer page
// ---------------------------------------------------------------------------

export default function PacerPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pacerConvId, setPacerConvId] = useState<string | null>(null);

  // Latest phase — used for auto-listen after rest
  const [latestPhase, setLatestPhase] = useState<string | null>(null);
  const [latestRestSeconds, setLatestRestSeconds] = useState<number | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const voiceInputRef = useRef<VoiceInputHandle | null>(null);

  // ---------------------------------------------------------------------------
  // Auth check
  // ---------------------------------------------------------------------------
  useEffect(() => {
    createClient()
      .auth.getSession()
      .then(({ data }) => {
        if (!data.session) router.replace("/login");
        else setReady(true);
      });
  }, [router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread, loading]);

  // ---------------------------------------------------------------------------
  // Auto-listen: when rest timer ends (phase was "resting"), auto-start voice
  // We detect this by watching the latest response phase + rest_seconds.
  // The WorkoutPacer component handles the countdown; here we just set a timer
  // to trigger auto-listen when rest_seconds elapses.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (latestPhase !== "resting" || !latestRestSeconds || latestRestSeconds <= 0) return;

    const timerId = setTimeout(() => {
      // Auto-start voice recognition after rest is done
      voiceInputRef.current?.startListening();
    }, (latestRestSeconds + 1) * 1000); // +1s buffer after timer ends

    return () => clearTimeout(timerId);
  }, [latestPhase, latestRestSeconds]);

  // ---------------------------------------------------------------------------
  // VoiceInput handler
  // ---------------------------------------------------------------------------
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
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setLoading(false);
      }
    },
    [pacerConvId]
  );

  // ---------------------------------------------------------------------------
  // Manual action handler — calls REST endpoints directly, no LLM roundtrip
  // ---------------------------------------------------------------------------
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
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setLoading(false);
      }
    },
    [pacerConvId]
  );

  // ---------------------------------------------------------------------------
  // Quick actions
  // ---------------------------------------------------------------------------
  function handleEndSession() {
    handleTranscript("end session");
  }

  function handleClear() {
    setThread([]);
    setPacerConvId(null);
    setError(null);
    setLatestPhase(null);
    setLatestRestSeconds(null);
  }

  if (!ready) return null;

  // Derive session info from latest pacer response
  const latestPacer = [...thread].reverse().find(
    (m): m is AssistantMessage => m.role === "assistant" && !!m.pacer
  )?.pacer;

  const sessionActive = latestPacer && latestPacer.phase !== "done" && latestPacer.total_exercises > 0;
  const sessionDone = latestPacer?.phase === "done";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <main style={{ maxWidth: "720px", margin: "0 auto", padding: "2rem 1rem" }}>

      {/* Page header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
        <div>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0 }}>Pacer</h1>
          <p style={{ color: "#9ca3af", fontSize: "0.875rem", margin: "0.25rem 0 0" }}>
            Voice-guided workouts. Say &quot;start my push workout&quot; to begin.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {sessionActive && (
            <button
              onClick={handleEndSession}
              disabled={loading}
              style={{
                fontSize: "0.8rem", fontWeight: 600, color: "#dc2626",
                background: "none", border: "1px solid #fecaca",
                borderRadius: "0.375rem", cursor: "pointer",
                padding: "0.3rem 0.6rem",
                opacity: loading ? 0.5 : 1,
              }}
            >
              End Session
            </button>
          )}
          {thread.length > 0 && (
            <button
              onClick={handleClear}
              style={{
                fontSize: "0.8rem", color: "#6b7280",
                background: "none", border: "none", cursor: "pointer", padding: "0.2rem 0.4rem",
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div style={{ marginTop: "1.5rem" }} />

      {/* Message thread */}
      {thread.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "1.5rem" }}>
          {thread.map((msg, i) => {
            if (msg.role === "user") {
              return (
                <div key={i} style={{ display: "flex", justifyContent: "flex-end" }}>
                  <div style={{
                    maxWidth: "85%",
                    backgroundColor: "#111827", color: "white",
                    borderRadius: "0.75rem 0.75rem 0.125rem 0.75rem",
                    padding: "0.625rem 0.875rem",
                  }}>
                    <p style={{ margin: 0, fontSize: "0.875rem" }}>{msg.text}</p>
                  </div>
                </div>
              );
            }

            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                <span style={{ fontSize: "0.7rem", color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Pacer
                </span>
                <div style={{
                  backgroundColor: "white", border: "1px solid #e5e7eb",
                  borderRadius: "0.125rem 0.75rem 0.75rem 0.75rem",
                  padding: "0.875rem",
                }}>
                  {msg.pacer ? (
                    <WorkoutPacer response={msg.pacer} onAction={handleManualAction} />
                  ) : (
                    <p style={{ margin: 0, fontSize: "0.875rem", color: "#374151" }}>{msg.text}</p>
                  )}
                </div>
              </div>
            );
          })}

          {loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.7rem", color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Thinking...
              </span>
              <div style={{
                backgroundColor: "#f3f4f6", border: "1px solid #e5e7eb",
                borderRadius: "0.125rem 0.75rem 0.75rem 0.75rem",
                padding: "0.875rem",
                color: "#9ca3af", fontSize: "0.875rem",
              }}>
                ···
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      )}

      {/* Empty state */}
      {thread.length === 0 && !loading && (
        <div style={{ textAlign: "center", padding: "3rem 1rem", color: "#9ca3af" }}>
          <p style={{ fontSize: "2.5rem", margin: "0 0 1rem" }}>🏋️</p>
          <p style={{ fontSize: "0.95rem", margin: "0 0 0.5rem", fontWeight: 600, color: "#374151" }}>
            Ready to train?
          </p>
          <p style={{ fontSize: "0.875rem", margin: 0, color: "#9ca3af" }}>
            Say &quot;start my push workout&quot; to get a guided plan, or &quot;done&quot; after each set.
          </p>

          {/* Quick-start buttons */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "center", marginTop: "1.5rem" }}>
            {["push", "pull", "legs", "chest", "back", "arms"].map((stype) => (
              <button
                key={stype}
                onClick={() => handleTranscript(`start my ${stype} workout`)}
                disabled={loading}
                style={{
                  fontSize: "0.8rem", fontWeight: 600,
                  padding: "0.4rem 0.75rem",
                  borderRadius: "9999px",
                  border: "1px solid #d1d5db",
                  backgroundColor: "white",
                  color: "#374151",
                  cursor: "pointer",
                  textTransform: "capitalize",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f3f4f6";
                  e.currentTarget.style.borderColor = "#9ca3af";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "white";
                  e.currentTarget.style.borderColor = "#d1d5db";
                }}
              >
                {stype}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <p role="alert" style={{ color: "#dc2626", fontSize: "0.875rem", marginBottom: "0.75rem" }}>
          {error}
        </p>
      )}

      {/* Session summary after done */}
      {sessionDone && latestPacer && (
        <div style={{
          padding: "1rem", borderRadius: "0.625rem",
          backgroundColor: "#fafafa", border: "1px solid #e5e7eb",
          marginBottom: "1rem", textAlign: "center",
        }}>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.95rem", fontWeight: 700, color: "#111827" }}>
            Session Complete
          </p>
          <p style={{ margin: 0, fontSize: "0.875rem", color: "#6b7280" }}>
            {latestPacer.completed_exercises} exercise{latestPacer.completed_exercises !== 1 ? "s" : ""} logged
            {latestPacer.session_type ? ` • ${latestPacer.session_type} day` : ""}
          </p>
          <button
            onClick={handleClear}
            style={{
              marginTop: "0.75rem", fontSize: "0.8rem", fontWeight: 600,
              padding: "0.4rem 1rem", borderRadius: "0.375rem",
              border: "1px solid #d1d5db", backgroundColor: "white",
              color: "#374151", cursor: "pointer",
            }}
          >
            Start New Session
          </button>
        </div>
      )}

      {/* Sticky voice input */}
      <div style={{
        position: "sticky", bottom: 0,
        backgroundColor: "white",
        paddingTop: "0.75rem",
        borderTop: thread.length > 0 ? "1px solid #e5e7eb" : "none",
      }}>
        <VoiceInput
          ref={voiceInputRef}
          onTranscript={handleTranscript}
          disabled={loading}
          label="Or type a command:"
          placeholder="'start my push workout', 'done', 'done 10 at 155'..."
          submitLabel="Send"
        />
      </div>
    </main>
  );
}
