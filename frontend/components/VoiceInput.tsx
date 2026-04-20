"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type {
  ISpeechRecognition,
  SpeechRecognitionEvent,
  SpeechRecognitionErrorEvent,
} from "@/lib/speech-types";
// Side-effect import to ensure the global Window augmentation is loaded
import "@/lib/speech-types";

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  submitLabel?: string;
  /** Called right before manual speech recognition starts (e.g. to pause wake word) */
  onListenStart?: () => void;
  /** Called when manual speech recognition ends (e.g. to resume wake word) */
  onListenEnd?: () => void;
}

export interface VoiceInputHandle {
  startListening: () => void;
}

type RecognitionState = "idle" | "listening";

const VoiceInput = forwardRef<VoiceInputHandle, VoiceInputProps>(function VoiceInput({
  onTranscript,
  disabled = false,
  label,
  placeholder = "e.g. bench press 3x10 at 135 lbs",
  submitLabel = "Log",
  onListenStart,
  onListenEnd,
}, ref) {
  const [state, setState] = useState<RecognitionState>("idle");
  const [interimText, setInterimText] = useState("");
  const [textInput, setTextInput] = useState("");
  const [speechSupported, setSpeechSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  // Keep a ref to the latest transcript so onend closure reads current value
  const transcriptRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    const SILENCE_MS = 2000;

    const recognition: ISpeechRecognition = new API();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    // Notify parent to pause wake word listening
    onListenStart?.();

    const resetSilenceTimer = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        recognition.stop();
      }, SILENCE_MS);
    };

    recognition.onstart = () => {
      setState("listening");
      resetSilenceTimer();
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const results = event.results;
      const parts: string[] = [];
      for (let i = 0; i < results.length; i++) {
        parts.push(results[i][0].transcript);
      }
      const current = parts.join("");
      setInterimText(current);
      transcriptRef.current = current;
      resetSilenceTimer();
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setState("idle");
      const final = transcriptRef.current.trim();
      if (final) {
        onTranscript(final);
        setInterimText("");
      }
      // Notify parent to resume wake word listening
      onListenEnd?.();
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      recognitionRef.current = null;
      setState("idle");
      setError(`Speech error: ${event.error}`);
      // Resume wake word on error too
      onListenEnd?.();
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [onTranscript, onListenStart, onListenEnd]);

  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    recognitionRef.current?.stop();
  }, []);

  // Expose startListening to parent components via ref
  useImperativeHandle(ref, () => ({
    startListening,
  }), [startListening]);

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
          {label ?? (speechSupported ? "Or type your workout:" : "Describe your workout:")}
        </label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            id="workout-text-input"
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={placeholder}
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
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
});

export default VoiceInput;
