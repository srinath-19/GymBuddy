"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { sendChat, ChatResponse } from "@/lib/chat-api";
import type { ExerciseCoachResponse, CoachAPIResponse } from "@/lib/coach-api";
import { resizeImageToBase64 } from "@/lib/coach-api";
import CoachResponse from "@/components/CoachResponse";
import CameraCapture from "@/components/CameraCapture";
import VoiceInput from "@/components/VoiceInput";
import { addWorkoutManually, logWorkout, type AgentActionResponse } from "@/lib/api";

// ---------------------------------------------------------------------------
// Message thread types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Coach page
// ---------------------------------------------------------------------------

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

  // Keep ref in sync so VoiceInput callback captures latest pendingImage
  useEffect(() => {
    pendingImageRef.current = pendingImage;
  }, [pendingImage]);

  // ---------------------------------------------------------------------------
  // Image helpers
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Core submit logic
  // ---------------------------------------------------------------------------
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
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setLoading(false);
      }
    },
    [coachConvId]
  );

  // ---------------------------------------------------------------------------
  // VoiceInput handler — captures pending image at fire time
  // ---------------------------------------------------------------------------
  const handleTranscript = useCallback(
    (voiceText: string) => {
      const img = pendingImageRef.current;
      setPendingImage(null);
      const trimmed = voiceText.trim();
      const LOG_INTENT = /\b(log\s+this|log\s+it|record\s+this|save\s+this)\b/i;

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

  // ---------------------------------------------------------------------------
  // Clear conversation
  // ---------------------------------------------------------------------------
  function handleClear() {
    setThread([]);
    setCoachConvId(null);
    setError(null);
    setPendingImage(null);
  }

  if (!ready) return null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <main style={{ maxWidth: "720px", margin: "0 auto", padding: "2rem 1rem" }}>

      {/* Page header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
        <div>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0 }}>Coach</h1>
          <p style={{ color: "#9ca3af", fontSize: "0.875rem", margin: "0.25rem 0 0" }}>
            Ask about exercise form, identify equipment, or get technique guidance.
          </p>
        </div>
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
                    {msg.image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={msg.image}
                        alt="uploaded"
                        style={{ width: "100%", maxHeight: "160px", objectFit: "cover", borderRadius: "0.375rem", marginBottom: "0.4rem" }}
                      />
                    )}
                    {msg.text && <p style={{ margin: 0, fontSize: "0.875rem" }}>{msg.text}</p>}
                  </div>
                </div>
              );
            }

            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                <span style={{ fontSize: "0.7rem", color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Coach
                </span>
                <div style={{
                  backgroundColor: "white", border: "1px solid #e5e7eb",
                  borderRadius: "0.125rem 0.75rem 0.75rem 0.75rem",
                  padding: "0.875rem",
                }}>
                  {msg.coach ? (
                    <CoachResponse response={msg.coach} onLogExercise={handleLogExercise} />
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
          <p style={{ fontSize: "0.95rem", margin: 0 }}>
            Ask about exercise form, identify equipment from a photo, or get guidance on a specific muscle group.
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <p role="alert" style={{ color: "#dc2626", fontSize: "0.875rem", marginBottom: "0.75rem" }}>
          {error}
        </p>
      )}

      {/* Input area — sticky at bottom */}
      <div style={{
        position: "sticky", bottom: 0,
        backgroundColor: "white",
        paddingTop: "0.75rem",
        borderTop: thread.length > 0 ? "1px solid #e5e7eb" : "none",
      }}>
        {/* Pending image preview */}
        {pendingImage && (
          <div style={{ position: "relative", marginBottom: "0.5rem" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pendingImage}
              alt="preview"
              style={{ width: "100%", maxHeight: "120px", objectFit: "cover", borderRadius: "0.375rem", border: "1px solid #e5e7eb" }}
            />
            <button
              type="button"
              onClick={() => setPendingImage(null)}
              style={{
                position: "absolute", top: "0.25rem", right: "0.25rem",
                background: "rgba(0,0,0,0.5)", color: "white",
                border: "none", borderRadius: "9999px",
                width: "1.4rem", height: "1.4rem", cursor: "pointer", fontSize: "0.7rem",
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Image buttons */}
        <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem" }}>
          <button
            type="button"
            onClick={() => setShowCamera(true)}
            title="Use camera"
            style={{
              padding: "0.4rem 0.6rem", background: "none",
              border: "1px solid #d1d5db", borderRadius: "0.375rem",
              cursor: "pointer", fontSize: "1rem", color: "#6b7280",
            }}
          >
            📷
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Upload image"
            style={{
              padding: "0.4rem 0.6rem", background: "none",
              border: "1px solid #d1d5db", borderRadius: "0.375rem",
              cursor: "pointer", fontSize: "1rem", color: "#6b7280",
            }}
          >
            🖼
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
        </div>

        {/* Voice + text input */}
        <VoiceInput
          onTranscript={handleTranscript}
          disabled={loading}
          label="Or type your question:"
          placeholder="Ask about form, technique, or equipment..."
          submitLabel="Send"
        />
      </div>

      {/* Camera modal */}
      {showCamera && (
        <CameraCapture
          onCapture={handleCameraCapture}
          onClose={() => setShowCamera(false)}
        />
      )}

      {/* Log workout modal */}
      {logModal && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "1rem" }}>
          <div style={{ backgroundColor: "white", borderRadius: "0.75rem", width: "100%", maxWidth: "400px", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.875rem 1rem", borderBottom: "1px solid #e5e7eb" }}>
              <span style={{ fontWeight: 700, fontSize: "0.95rem", color: "#111827" }}>Log Exercise</span>
              <button onClick={() => setLogModal(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1.1rem", color: "#6b7280" }}>✕</button>
            </div>
            <form onSubmit={handleLogSubmit} style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.25rem" }}>Exercise</label>
                <input type="text" value={logModal.exerciseName} readOnly style={{ width: "100%", padding: "0.5rem 0.75rem", fontSize: "0.875rem", border: "1px solid #e5e7eb", borderRadius: "0.375rem", backgroundColor: "#f9fafb", color: "#374151", boxSizing: "border-box" }} />
              </div>
              <div style={{ display: "flex", gap: "0.75rem" }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.25rem" }}>Sets</label>
                  <input type="number" min="1" max="99" value={logSets} onChange={(e) => setLogSets(e.target.value)} style={{ width: "100%", padding: "0.5rem 0.75rem", fontSize: "0.875rem", border: "1px solid #d1d5db", borderRadius: "0.375rem", boxSizing: "border-box" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.25rem" }}>Reps</label>
                  <input type="number" min="1" max="999" value={logReps} onChange={(e) => setLogReps(e.target.value)} style={{ width: "100%", padding: "0.5rem 0.75rem", fontSize: "0.875rem", border: "1px solid #d1d5db", borderRadius: "0.375rem", boxSizing: "border-box" }} />
                </div>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.25rem" }}>Weight</label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <input type="number" min="0" step="0.5" value={logWeight} onChange={(e) => setLogWeight(e.target.value)} style={{ flex: 1, padding: "0.5rem 0.75rem", fontSize: "0.875rem", border: "1px solid #d1d5db", borderRadius: "0.375rem" }} />
                  <select value={logUnit} onChange={(e) => setLogUnit(e.target.value as "lbs" | "kg")} style={{ padding: "0.5rem", fontSize: "0.875rem", border: "1px solid #d1d5db", borderRadius: "0.375rem", backgroundColor: "white", cursor: "pointer" }}>
                    <option value="lbs">lbs</option>
                    <option value="kg">kg</option>
                  </select>
                </div>
              </div>
              {logError && <p role="alert" style={{ margin: 0, fontSize: "0.8rem", color: "#dc2626" }}>{logError}</p>}
              <button type="submit" disabled={logSubmitting} style={{ padding: "0.625rem", backgroundColor: logSubmitting ? "#6b7280" : "#111827", color: "white", border: "none", borderRadius: "0.5rem", fontSize: "0.875rem", fontWeight: 600, cursor: logSubmitting ? "not-allowed" : "pointer" }}>
                {logSubmitting ? "Logging..." : "Log Workout"}
              </button>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
