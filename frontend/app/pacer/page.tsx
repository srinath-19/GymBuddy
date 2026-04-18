"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { sendChat, ChatResponse, PacerAPIResponse } from "@/lib/chat-api";
import WorkoutPacer from "@/components/WorkoutPacer";
import VoiceInput from "@/components/VoiceInput";

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
  // Clear session
  // ---------------------------------------------------------------------------
  function handleClear() {
    setThread([]);
    setPacerConvId(null);
    setError(null);
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
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0 }}>Pacer</h1>
          <p style={{ color: "#9ca3af", fontSize: "0.875rem", margin: "0.25rem 0 0" }}>
            Start a guided workout session, log sets, and track rest periods.
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
                    <WorkoutPacer response={msg.pacer} />
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
            Say &quot;start my push workout&quot; to begin, or &quot;done, 3 sets of 10 at 135 lbs&quot; to log a set.
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <p role="alert" style={{ color: "#dc2626", fontSize: "0.875rem", marginBottom: "0.75rem" }}>
          {error}
        </p>
      )}

      {/* Sticky voice input */}
      <div style={{
        position: "sticky", bottom: 0,
        backgroundColor: "white",
        paddingTop: "0.75rem",
        borderTop: thread.length > 0 ? "1px solid #e5e7eb" : "none",
      }}>
        <VoiceInput
          onTranscript={handleTranscript}
          disabled={loading}
          label="Or type a command:"
          placeholder="'start my push workout', 'done, 3x10 at 135'..."
          submitLabel="Send"
        />
      </div>
    </main>
  );
}
