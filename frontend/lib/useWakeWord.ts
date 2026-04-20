"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ISpeechRecognition,
  SpeechRecognitionEvent,
  SpeechRecognitionErrorEvent,
} from "@/lib/speech-types";
import "@/lib/speech-types";

// ---------------------------------------------------------------------------
// Wake word patterns — matches "gym buddy", "hey gym buddy", etc
// ---------------------------------------------------------------------------
const WAKE_PATTERNS = [
  /\bhey\s+gym\s*buddy\b/i,
  /\bgym\s*buddy\b/i,
  /\bjim\s*buddy\b/i,
  /\bhey\s+jim\s*buddy\b/i,
  /\bgym\s*body\b/i,
  /\bhey\s+gym\s*body\b/i,
  /\bgive\s*buddy\b/i,      // "give buddy" — hard-g mis-hear
  /\bjim\s*body\b/i,        // "jim body" — combined mis-transcription
];

function extractCommand(transcript: string): string | null {
  for (const pattern of WAKE_PATTERNS) {
    const match = transcript.match(pattern);
    if (match) {
      // Return everything after the wake phrase
      const afterWake = transcript.slice(match.index! + match[0].length).trim();
      return afterWake;
    }
  }
  return null;
}

function containsWakeWord(transcript: string): boolean {
  return WAKE_PATTERNS.some((p) => p.test(transcript));
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
interface UseWakeWordOptions {
  /** Called when a complete command is detected after the wake word */
  onCommand: (command: string) => void;
  /** Whether to listen (default true). Set false to pause. */
  enabled?: boolean;
  /** Silence timeout after wake word activation — how long to wait for the
   *  user to finish speaking the command (ms). Default 1200. */
  commandSilenceMs?: number;
  /** Whether to suppress listening (e.g. while TTS is playing) */
  suppressed?: boolean;
}

interface UseWakeWordReturn {
  /** True when the mic is actively listening for the wake word */
  isListening: boolean;
  /** True when the wake word was detected and we're capturing the command */
  isActivated: boolean;
  /** Current interim text being recognized */
  interimText: string;
  /** Whether the browser supports speech recognition */
  supported: boolean;
  /** Temporarily pause wake word listening (e.g. when manual Speak button is used) */
  pause: () => void;
  /** Resume wake word listening after a pause */
  resume: () => void;
}

export function useWakeWord({
  onCommand,
  enabled = true,
  commandSilenceMs = 2000,
  suppressed = false,
}: UseWakeWordOptions): UseWakeWordReturn {
  const [isListening, setIsListening] = useState(false);
  const [isActivated, setIsActivated] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [supported, setSupported] = useState(false);

  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const intentionalStopRef = useRef(false);
  const activatedRef = useRef(false);
  const commandBufferRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommandRef = useRef(onCommand);
  const suppressedRef = useRef(suppressed);
  const pausedRef = useRef(false);
  // Prevents ghost recognizer from restarting after component unmounts
  const destroyedRef = useRef(false);

  // Keep refs in sync with latest props
  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);
  useEffect(() => { suppressedRef.current = suppressed; }, [suppressed]);

  // Feature detection
  useEffect(() => {
    const API = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setSupported(API != null);
  }, []);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const startListening = useCallback(() => {
    const API = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!API) return;

    // Don't start if suppressed (TTS playing), paused (manual Speak), or destroyed (unmounted)
    if (suppressedRef.current || pausedRef.current || destroyedRef.current) return;

    // Clean up any existing instance
    if (recognitionRef.current) {
      intentionalStopRef.current = true;
      try { recognitionRef.current.abort(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }

    const recognition = new API();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setIsListening(true);
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (activatedRef.current) {
        // Command capture mode: use full accumulated transcript for extraction
        const parts: string[] = [];
        for (let i = 0; i < event.results.length; i++) {
          parts.push(event.results[i][0].transcript);
        }
        const fullTranscript = parts.join("").trim();
        commandBufferRef.current = fullTranscript;
        setInterimText(fullTranscript);

        // Silence timer — fires when user stops speaking for commandSilenceMs
        clearSilenceTimer();
        silenceTimerRef.current = setTimeout(() => {
          const cmd = extractCommand(commandBufferRef.current);
          if (cmd && cmd.length > 0) {
            onCommandRef.current(cmd);
          }
          activatedRef.current = false;
          setIsActivated(false);
          setInterimText("");
          commandBufferRef.current = "";
          intentionalStopRef.current = true;
          try { recognition.stop(); } catch { /* ignore */ }
        }, commandSilenceMs);

      } else {
        // Passive mode: look back 2 extra slots so wake words split across result
        // boundaries (Chrome can finalize "gym" and "buddy" separately) still match
        const newParts: string[] = [];
        const checkFrom = Math.max(0, event.resultIndex - 2);
        for (let i = checkFrom; i < event.results.length; i++) {
          newParts.push(event.results[i][0].transcript);
        }
        const latestText = newParts.join("").trim();

        if (containsWakeWord(latestText)) {
          const immediateCmd = extractCommand(latestText);

          if (immediateCmd && immediateCmd.length > 3) {
            // User said "gym buddy <command>" all in one go — wait for silence
            activatedRef.current = true;
            setIsActivated(true);
            commandBufferRef.current = latestText;
            setInterimText(latestText);

            clearSilenceTimer();
            silenceTimerRef.current = setTimeout(() => {
              const cmd = extractCommand(commandBufferRef.current);
              if (cmd && cmd.length > 0) {
                onCommandRef.current(cmd);
              }
              activatedRef.current = false;
              setIsActivated(false);
              setInterimText("");
              commandBufferRef.current = "";
              intentionalStopRef.current = true;
              try { recognition.stop(); } catch { /* ignore */ }
            }, commandSilenceMs);
          } else {
            // Wake word only detected — waiting for command to follow
            activatedRef.current = true;
            setIsActivated(true);
            commandBufferRef.current = latestText;
            setInterimText(latestText);

            clearSilenceTimer();
            silenceTimerRef.current = setTimeout(() => {
              activatedRef.current = false;
              setIsActivated(false);
              setInterimText("");
              commandBufferRef.current = "";
              intentionalStopRef.current = true;
              try { recognition.stop(); } catch { /* ignore */ }
            }, commandSilenceMs * 2);
          }
        }
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setIsListening(false);

      if (intentionalStopRef.current) {
        intentionalStopRef.current = false;
        // Auto-restart after a brief pause — but NOT if the component has unmounted
        if (!destroyedRef.current && enabled && !suppressedRef.current && !pausedRef.current) {
          setTimeout(() => {
            startListening();
          }, 300);
        }
      } else {
        // Unintentional stop (Chrome auto-stops after silence) — restart
        if (!destroyedRef.current && enabled && !suppressedRef.current && !pausedRef.current) {
          setTimeout(() => {
            startListening();
          }, 300);
        }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "no-speech" and "aborted" are normal — just restart
      if (event.error === "no-speech" || event.error === "aborted") {
        return; // onend will fire and handle restart
      }
      console.warn("[useWakeWord] Speech error:", event.error);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // Already started or other issue — retry after delay
      setTimeout(() => startListening(), 500);
    }
  }, [enabled, commandSilenceMs, clearSilenceTimer]);

  const stopListening = useCallback(() => {
    clearSilenceTimer();
    intentionalStopRef.current = true;
    activatedRef.current = false;
    setIsActivated(false);
    setInterimText("");
    commandBufferRef.current = "";
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, [clearSilenceTimer]);

  // Start/stop based on enabled + suppressed
  useEffect(() => {
    destroyedRef.current = false; // reset on each effect run (handles re-mount)
    if (enabled && !suppressed && supported) {
      startListening();
    } else {
      stopListening();
    }
    return () => {
      destroyedRef.current = true; // prevent ghost recognizer from restarting after unmount
      stopListening();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, suppressed, supported]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    stopListening();
  }, [stopListening]);

  const resume = useCallback(() => {
    pausedRef.current = false;
    if (enabled && !suppressed && supported) {
      startListening();
    }
  }, [enabled, suppressed, supported, startListening]);

  return { isListening, isActivated, interimText, supported, pause, resume };
}
