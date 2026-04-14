"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Web Speech API type declarations
// These are not universally available in TypeScript's lib.dom.d.ts across all
// configurations, so we declare them explicitly to stay strict-mode clean.
// ---------------------------------------------------------------------------
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface ISpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionConstructor {
  new (): ISpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition: SpeechRecognitionConstructor | undefined;
    webkitSpeechRecognition: SpeechRecognitionConstructor | undefined;
  }
}

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

type RecognitionState = "idle" | "listening";

export default function VoiceInput({
  onTranscript,
  disabled = false,
}: VoiceInputProps) {
  const [state, setState] = useState<RecognitionState>("idle");
  const [interimText, setInterimText] = useState("");
  const [textInput, setTextInput] = useState("");
  const [speechSupported, setSpeechSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  // Keep a ref to the latest transcript so onend closure reads current value
  const transcriptRef = useRef("");

  useEffect(() => {
    // Feature-detect on mount — useEffect is SSR-safe (client-only)
    const API = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setSpeechSupported(API != null);
  }, []);

  const startListening = useCallback(() => {
    const API = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!API) return;

    setError(null);
    setInterimText("");
    transcriptRef.current = "";

    const recognition: ISpeechRecognition = new API();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => setState("listening");

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const results = event.results;
      const parts: string[] = [];
      for (let i = 0; i < results.length; i++) {
        parts.push(results[i][0].transcript);
      }
      const current = parts.join("");
      setInterimText(current);
      transcriptRef.current = current;
    };

    recognition.onend = () => {
      setState("idle");
      const final = transcriptRef.current.trim();
      if (final) {
        onTranscript(final);
        setInterimText("");
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setState("idle");
      setError(`Speech error: ${event.error}`);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [onTranscript]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = textInput.trim();
    if (value) {
      onTranscript(value);
      setTextInput("");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {error && (
        <p role="alert" style={{ color: "#dc2626", margin: 0 }}>
          {error}
        </p>
      )}

      {speechSupported && (
        <div>
          <button
            type="button"
            onClick={state === "listening" ? stopListening : startListening}
            disabled={disabled}
            aria-label={
              state === "listening" ? "Stop recording" : "Start voice input"
            }
            style={{
              padding: "0.75rem 1.5rem",
              fontSize: "1rem",
              backgroundColor: state === "listening" ? "#dc2626" : "#2563eb",
              color: "white",
              border: "none",
              borderRadius: "0.5rem",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.6 : 1,
            }}
          >
            {state === "listening" ? "Stop" : "Speak"}
          </button>

          {interimText && (
            <p
              style={{
                fontStyle: "italic",
                color: "#6b7280",
                marginTop: "0.5rem",
                marginBottom: 0,
              }}
            >
              {interimText}
            </p>
          )}
        </div>
      )}

      {/* Text input — always visible; primary input for Firefox and keyboard users */}
      <form onSubmit={handleTextSubmit}>
        <label
          htmlFor="workout-text-input"
          style={{ display: "block", marginBottom: "0.25rem", fontWeight: 500 }}
        >
          {speechSupported ? "Or type your workout:" : "Describe your workout:"}
        </label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            id="workout-text-input"
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="e.g. bench press 3x10 at 135 lbs"
            disabled={disabled}
            style={{
              flex: 1,
              padding: "0.5rem 0.75rem",
              fontSize: "1rem",
              border: "1px solid #d1d5db",
              borderRadius: "0.5rem",
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={disabled || !textInput.trim()}
            style={{
              padding: "0.5rem 1rem",
              fontSize: "1rem",
              backgroundColor: "#16a34a",
              color: "white",
              border: "none",
              borderRadius: "0.5rem",
              cursor: disabled || !textInput.trim() ? "not-allowed" : "pointer",
              opacity: disabled || !textInput.trim() ? 0.6 : 1,
            }}
          >
            Log
          </button>
        </div>
      </form>
    </div>
  );
}
