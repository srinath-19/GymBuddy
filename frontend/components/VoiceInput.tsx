"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type {
  ISpeechRecognition,
  SpeechRecognitionEvent,
  SpeechRecognitionErrorEvent,
} from "@/lib/speech-types";
import "@/lib/speech-types";
import {
  combinedTranscript,
  describeSpeechError,
  getSpeechRecognitionCtor,
  isMobileBrowser,
  splitTranscript,
  supportsContinuous,
} from "@/lib/speech";
import { extensionForMimeType, useAudioRecorder } from "@/lib/useAudioRecorder";
import { transcribeAudio } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  /**
   * Optional single-request path for recorded audio. When supplied, a mobile
   * recording is handed over as-is for the caller to upload and transcribe in one
   * call, instead of being transcribed here and passed to `onTranscript` — which
   * costs an extra round-trip. Callers without an audio-capable endpoint simply
   * omit this and get the two-step behaviour.
   */
  onAudio?: (audio: Blob, filename: string) => Promise<void>;
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

type RecognitionState = "idle" | "starting" | "listening" | "transcribing";

/** Grace period for the wake-word recognizer to actually release the microphone.
 *  `abort()` is asynchronous, and on Android acquiring the mic too soon afterwards
 *  yields a dead session or an immediate `aborted` error. */
const MIC_RELEASE_MS = 250;

/** Below this, the clip is a stray tap rather than speech — not worth a round-trip. */
const MIN_AUDIO_BYTES = 1200;

const VoiceInput = forwardRef<VoiceInputHandle, VoiceInputProps>(function VoiceInput({
  onTranscript,
  onAudio,
  disabled = false,
  label,
  placeholder = "e.g. bench press 3x10, or what did I do today?",
  submitLabel = "Send",
  onListenStart,
  onListenEnd,
}, ref) {
  const [state, setState] = useState<RecognitionState>("idle");
  const [interimText, setInterimText] = useState("");
  const [textInput, setTextInput] = useState("");
  const [speechSupported, setSpeechSupported] = useState(false);
  const [useRecording, setUseRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const transcriptRef = useRef("");
  const lastInterimRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishRecordingRef = useRef<() => void>(() => {});
  const stoppingRef = useRef(false);

  const recorder = useAudioRecorder({
    onAutoStop: () => finishRecordingRef.current(),
  });

  useEffect(() => {
    setSpeechSupported(getSpeechRecognitionCtor() != null);
  }, []);

  // Phones record audio and transcribe it server-side instead of using the Web
  // Speech API: Android Chrome and iOS Safari delegate to platform recognizers
  // that duplicate and truncate transcripts. Desktop Chrome's implementation is
  // solid and stays on the local path, which avoids a network round-trip.
  useEffect(() => {
    setUseRecording(recorder.supported && isMobileBrowser());
  }, [recorder.supported]);

  // -------------------------------------------------------------------------
  // Path A — record + server transcription (mobile)
  // -------------------------------------------------------------------------
  const finishRecording = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setState("transcribing");
    setInterimText("");

    try {
      const blob = await recorder.stop();
      if (!blob || blob.size < MIN_AUDIO_BYTES) {
        setError("Didn't catch that — try again.");
        return;
      }
      // The blob carries the container the recorder actually chose, which is the
      // authoritative value — on iOS it will be mp4 rather than the webm default.
      const filename = `speech.${extensionForMimeType(blob.type || recorder.mimeType)}`;

      if (onAudio) {
        // Single-request path: the caller uploads the clip and transcribes it
        // server-side as part of the same call.
        await onAudio(blob, filename);
        return;
      }

      const text = await transcribeAudio(blob, filename);
      if (text) {
        onTranscript(text);
      } else {
        setError("Didn't catch that — try again.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not transcribe audio.");
    } finally {
      stoppingRef.current = false;
      setState("idle");
      onListenEnd?.();
    }
  }, [recorder, onAudio, onTranscript, onListenEnd]);

  useEffect(() => {
    finishRecordingRef.current = () => void finishRecording();
  }, [finishRecording]);

  const startRecording = useCallback(async () => {
    setError(null);
    setInterimText("");
    setState("starting");
    onListenStart?.();

    // Let the always-on wake-word recognizer let go of the mic first.
    await new Promise((resolve) => setTimeout(resolve, MIC_RELEASE_MS));

    const result = await recorder.start();
    if (!result.ok) {
      setState("idle");
      setError(result.error);
      onListenEnd?.();
      return;
    }
    setState("listening");
  }, [recorder, onListenStart, onListenEnd]);

  // -------------------------------------------------------------------------
  // Path B — Web Speech API (desktop)
  // -------------------------------------------------------------------------
  const startSpeechRecognition = useCallback(async () => {
    const API = getSpeechRecognitionCtor();
    if (!API) return;

    setError(null);
    setInterimText("");
    transcriptRef.current = "";
    lastInterimRef.current = "";
    setState("starting");
    onListenStart?.();

    // Same handoff race as the recording path — the wake-word recognizer's
    // abort() has not released the microphone by the time this line runs.
    await new Promise((resolve) => setTimeout(resolve, MIC_RELEASE_MS));

    const SILENCE_MS = 2000;

    const recognition: ISpeechRecognition = new API();
    recognition.continuous = supportsContinuous();
    recognition.interimResults = true;
    recognition.lang = "en-US";

    const resetSilenceTimer = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        try { recognition.stop(); } catch { /* already stopped */ }
      }, SILENCE_MS);
    };

    recognition.onstart = () => {
      setState("listening");
      resetSilenceTimer();
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Only committed (isFinal) results are accumulated; interim ones are shown
      // as a live preview and discarded. Joining both is what produced repeated
      // text like "bench press bench press 3 bench press 3 by 10".
      const split = splitTranscript(event.results);
      transcriptRef.current = split.final;
      if (split.interim) lastInterimRef.current = split.interim;
      setInterimText(combinedTranscript(split));
      resetSilenceTimer();
    };

    recognition.onend = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      recognitionRef.current = null;
      setState("idle");
      // Fall back to the last interim text if the engine ended without ever
      // marking a result final — iOS Safari does this when it is cut off.
      const final = (transcriptRef.current || lastInterimRef.current).trim();
      if (final) {
        onTranscript(final);
        setInterimText("");
      }
      onListenEnd?.();
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      recognitionRef.current = null;
      setState("idle");
      // "no-speech" just means the user never spoke — not worth an error banner.
      if (event.error !== "no-speech" && event.error !== "aborted") {
        setError(describeSpeechError(event.error));
      }
      onListenEnd?.();
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setState("idle");
      setError("Could not start listening. Try again.");
      onListenEnd?.();
    }
  }, [onTranscript, onListenStart, onListenEnd]);

  // -------------------------------------------------------------------------
  // Shared controls
  // -------------------------------------------------------------------------
  const startListening = useCallback(() => {
    if (state !== "idle") return;
    if (useRecording) void startRecording();
    else void startSpeechRecognition();
  }, [state, useRecording, startRecording, startSpeechRecognition]);

  const stopListening = useCallback(() => {
    if (useRecording) {
      void finishRecording();
      return;
    }
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
  }, [useRecording, finishRecording]);

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

  const micAvailable = useRecording || speechSupported;
  const busy = state === "starting" || state === "transcribing";

  const buttonLabel =
    state === "listening" ? "🎙 Stop"
      : state === "starting" ? "… Starting"
        : state === "transcribing" ? "… Transcribing"
          : "🎤 Speak";

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-red-400 m-0 text-sm">
          {error}
        </p>
      )}

      {micAvailable && (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            onClick={state === "listening" ? stopListening : startListening}
            disabled={disabled || busy}
            aria-label={state === "listening" ? "Stop recording" : "Start voice input"}
            className={cn(
              "w-full text-base font-semibold transition-all",
              state === "listening"
                ? "bg-red-500/80 hover:bg-red-500 border border-red-400/50 text-white"
                : "bg-blue-600/70 hover:bg-blue-600 border border-blue-400/50 text-white"
            )}
          >
            {buttonLabel}
          </Button>

          {state === "listening" && useRecording && (
            <p className="text-white/40 text-xs mt-1 mb-0 text-center">
              Listening — pauses briefly, then sends automatically.
            </p>
          )}

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
          {label ?? (micAvailable ? "Or type a message:" : "Type a message:")}
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
