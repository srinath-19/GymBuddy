"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type {
  ISpeechRecognition,
  SpeechRecognitionEvent,
  SpeechRecognitionErrorEvent,
} from "@/lib/speech-types";
import "@/lib/speech-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  submitLabel?: string;
  onListenStart?: () => void;
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
  const transcriptRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
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
      onListenEnd?.();
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      recognitionRef.current = null;
      setState("idle");
      setError(`Speech error: ${event.error}`);
      onListenEnd?.();
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [onTranscript, onListenStart, onListenEnd]);

  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    recognitionRef.current?.stop();
  }, []);

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
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-red-400 m-0 text-sm">
          {error}
        </p>
      )}

      {speechSupported && (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            onClick={state === "listening" ? stopListening : startListening}
            disabled={disabled}
            aria-label={state === "listening" ? "Stop recording" : "Start voice input"}
            className={cn(
              "w-full text-base font-semibold transition-all",
              state === "listening"
                ? "bg-red-500/80 hover:bg-red-500 border border-red-400/50 text-white"
                : "bg-blue-600/70 hover:bg-blue-600 border border-blue-400/50 text-white"
            )}
          >
            {state === "listening" ? "🎙 Stop" : "🎤 Speak"}
          </Button>

          {interimText && (
            <p className="italic text-white/50 text-sm mt-1 mb-0">
              {interimText}
            </p>
          )}
        </div>
      )}

      <form onSubmit={handleTextSubmit} className="flex flex-col gap-2">
        <label
          htmlFor="workout-text-input"
          className="text-white/70 text-sm font-medium"
        >
          {label ?? (speechSupported ? "Or type your workout:" : "Describe your workout:")}
        </label>
        <div className="flex gap-2">
          <Input
            id="workout-text-input"
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            className="glass-input flex-1 text-base"
          />
          <Button
            type="submit"
            disabled={disabled || !textInput.trim()}
            className="bg-green-600/70 hover:bg-green-600 border border-green-400/50 text-white font-semibold"
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
});

export default VoiceInput;
