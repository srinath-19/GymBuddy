"use client";

import { useRef, useState } from "react";
import {
  CoachAPIResponse,
  ExerciseCoachResponse,
  askCoach,
  clearConversation,
  resizeImageToBase64,
} from "@/lib/coach-api";
import CoachResponse from "./CoachResponse";
import CameraCapture from "./CameraCapture";

interface ExerciseCoachProps {
  onLogExercise: (exerciseName: string) => void;
}

type CoachState = "idle" | "loading" | "error";

interface Message {
  role: "user" | "assistant";
  text: string;
  image?: string; // base64 preview
  response?: ExerciseCoachResponse;
}

export default function ExerciseCoach({ onLogExercise }: ExerciseCoachProps) {
  const [coachState, setCoachState] = useState<CoachState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turnCount, setTurnCount] = useState(0);
  const [maxTurns, setMaxTurns] = useState(6);

  const [text, setText] = useState("");
  const [pendingImage, setPendingImage] = useState<string | null>(null); // base64
  const [showCamera, setShowCamera] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const base64 = await resizeImageToBase64(file);
    setPendingImage(base64);
    e.target.value = "";
  }

  function handleCameraCapture(base64: string) {
    setPendingImage(base64);
    setShowCamera(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && !pendingImage) return;

    const userText = text.trim() || "What is this? How do I use it?";
    setCoachState("loading");
    setErrorMessage(null);

    // Optimistically add user message
    setMessages((prev) => [
      ...prev,
      { role: "user", text: userText, image: pendingImage ?? undefined },
    ]);
    setText("");
    const imageToSend = pendingImage;
    setPendingImage(null);

    try {
      const result: CoachAPIResponse = await askCoach({
        text: userText,
        image_base64: imageToSend ?? undefined,
        conversation_id: conversationId,
      });

      setConversationId(result.conversation_id);
      setTurnCount(result.turn_number);
      setMaxTurns(result.max_turns);

      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: result.response.message, response: result.response },
      ]);
      setCoachState("idle");
    } catch (err) {
      setCoachState("error");
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  async function handleNewQuestion() {
    if (conversationId) await clearConversation(conversationId).catch(() => {});
    setMessages([]);
    setConversationId(null);
    setTurnCount(0);
    setText("");
    setPendingImage(null);
    setErrorMessage(null);
    setCoachState("idle");
  }

  const atLimit = turnCount >= maxTurns;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Panel header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>Exercise Coach</h2>
        {messages.length > 0 && (
          <button
            onClick={handleNewQuestion}
            style={{
              fontSize: "0.8rem", color: "#6b7280",
              background: "none", border: "none", cursor: "pointer",
              padding: "0.2rem 0.4rem",
            }}
          >
            New Question
          </button>
        )}
      </div>

      {/* Message thread */}
      {messages.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "1rem" }}>
          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === "user" ? (
                <div style={{
                  backgroundColor: "#f8fafc", border: "1px solid #e2e8f0",
                  borderRadius: "0.5rem", padding: "0.75rem",
                }}>
                  {msg.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={msg.image}
                      alt="uploaded"
                      style={{ width: "100%", maxHeight: "180px", objectFit: "cover", borderRadius: "0.375rem", marginBottom: "0.5rem" }}
                    />
                  )}
                  <p style={{ margin: 0, fontSize: "0.875rem", color: "#374151" }}>{msg.text}</p>
                </div>
              ) : (
                <div style={{
                  backgroundColor: "white", border: "1px solid #e5e7eb",
                  borderRadius: "0.5rem", padding: "0.875rem",
                }}>
                  {msg.response ? (
                    <CoachResponse response={msg.response} onLogExercise={onLogExercise} />
                  ) : (
                    <p style={{ margin: 0, fontSize: "0.875rem", color: "#374151" }}>{msg.text}</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Loading */}
      {coachState === "loading" && (
        <p style={{ color: "#6b7280", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
          Thinking...
        </p>
      )}

      {/* Error */}
      {coachState === "error" && errorMessage && (
        <p role="alert" style={{ color: "#dc2626", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
          {errorMessage}
        </p>
      )}

      {/* At limit message */}
      {atLimit && messages.length > 0 && (
        <p style={{ fontSize: "0.8rem", color: "#9ca3af", marginBottom: "0.5rem" }}>
          Conversation limit reached.{" "}
          <button onClick={handleNewQuestion} style={{ color: "#2563eb", background: "none", border: "none", cursor: "pointer", fontSize: "0.8rem", padding: 0 }}>
            Start a new question
          </button>
        </p>
      )}

      {/* Input area */}
      {!atLimit && (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "auto" }}>
          {/* Pending image preview */}
          {pendingImage && (
            <div style={{ position: "relative", display: "inline-block" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={pendingImage}
                alt="preview"
                style={{ width: "100%", maxHeight: "140px", objectFit: "cover", borderRadius: "0.375rem", border: "1px solid #e5e7eb" }}
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

          {/* Text input row */}
          <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
            {/* Camera button */}
            <button
              type="button"
              onClick={() => setShowCamera(true)}
              title="Use camera"
              style={{
                padding: "0.4rem 0.6rem", background: "none",
                border: "1px solid #d1d5db", borderRadius: "0.375rem",
                cursor: "pointer", fontSize: "1rem", color: "#6b7280", flexShrink: 0,
              }}
            >
              📷
            </button>

            {/* File upload button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Upload image"
              style={{
                padding: "0.4rem 0.6rem", background: "none",
                border: "1px solid #d1d5db", borderRadius: "0.375rem",
                cursor: "pointer", fontSize: "1rem", color: "#6b7280", flexShrink: 0,
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

            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                messages.length === 0
                  ? "Ask about an exercise or upload a photo..."
                  : "Ask a follow-up..."
              }
              style={{
                flex: 1, padding: "0.4rem 0.6rem",
                border: "1px solid #d1d5db", borderRadius: "0.375rem",
                fontSize: "0.875rem", boxSizing: "border-box",
              }}
              disabled={coachState === "loading"}
            />

            <button
              type="submit"
              disabled={coachState === "loading" || (!text.trim() && !pendingImage)}
              style={{
                padding: "0.4rem 0.85rem",
                backgroundColor: "#111827", color: "white",
                border: "none", borderRadius: "0.375rem",
                fontSize: "0.875rem", cursor: "pointer", flexShrink: 0,
                opacity: (coachState === "loading" || (!text.trim() && !pendingImage)) ? 0.5 : 1,
              }}
            >
              Ask
            </button>
          </div>
        </form>
      )}

      {/* Camera modal */}
      {showCamera && (
        <CameraCapture
          onCapture={handleCameraCapture}
          onClose={() => setShowCamera(false)}
        />
      )}
    </div>
  );
}
