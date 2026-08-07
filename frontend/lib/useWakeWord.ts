"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  isFatalSpeechError,
  isMobileBrowser,
  splitTranscript,
  supportsContinuous,
} from "@/lib/speech";

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

/** Passive matching only considers the tail of the session transcript, so a long
 *  desktop session does not re-scan minutes of accumulated speech on every event. */
const PASSIVE_WINDOW_CHARS = 300;

/** Base delay before re-arming the recognizer, doubled on consecutive failures. */
const RESTART_MS = 300;
const MAX_RESTART_MS = 5000;

/** Extra settle time when starting after TTS, so the tail of the spoken reply
 *  coming out of a phone's loudspeaker is not transcribed as user speech. */
const RESUME_SETTLE_MS = 400;

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
  /** Whether hands-free wake word listening is available here. False on mobile —
   *  see the feature-detection effect for why. Consumers use this to hide wake
   *  word UI entirely. */
  supported: boolean;
  /** Set when listening stopped for a reason the user has to fix (e.g. mic blocked) */
  error: string | null;
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
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const activatedRef = useRef(false);
  const commandBufferRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommandRef = useRef(onCommand);
  const suppressedRef = useRef(suppressed);
  const pausedRef = useRef(false);
  // Prevents ghost recognizer from restarting after component unmounts
  const destroyedRef = useRef(false);
  // Whether listening is wanted right now. Kept as a ref because `onend` fires
  // asynchronously after `abort()` — by then the effect has already re-run, so
  // reading `enabled`/`suppressed` from a closure would restart a hook that was
  // just switched off.
  const shouldListenRef = useRef(false);
  // Set when the mic is blocked or missing — retrying cannot help until the user acts.
  const fatalRef = useRef(false);
  const consecutiveErrorsRef = useRef(0);
  const listeningRef = useRef(false);

  // Keep refs in sync with latest props
  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);
  useEffect(() => { suppressedRef.current = suppressed; }, [suppressed]);

  // Feature detection.
  //
  // Deliberately off on phones. Android's SpeechRecognizer cannot listen
  // continuously, so an always-on hotword has to be emulated by restarting the
  // recognizer after every single utterance — and each restart re-acquires the
  // microphone with an audible beep, drains the battery, and is throttled the
  // moment the tab is backgrounded. On mobile the Speak button records and
  // transcribes server-side instead, which is both reliable and more accurate.
  useEffect(() => {
    setSupported(getSpeechRecognitionCtor() != null && !isMobileBrowser());
  }, []);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const startListening = useCallback((delayMs = 0) => {
    const API = getSpeechRecognitionCtor();
    if (!API) return;

    // Don't start if switched off, suppressed (TTS), paused (manual Speak),
    // destroyed (unmounted), or already stopped for an unrecoverable reason.
    if (
      !shouldListenRef.current ||
      suppressedRef.current ||
      pausedRef.current ||
      destroyedRef.current ||
      fatalRef.current
    ) {
      return;
    }

    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (delayMs > 0) {
      restartTimerRef.current = setTimeout(() => startListening(0), delayMs);
      return;
    }

    // Clean up any existing instance
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }

    const recognition = new API();
    // Android's SpeechRecognizer has no continuous mode (Chromium bug 40324711) —
    // asking for it yields a session that dies after one utterance or never fires
    // `onend` at all, so mobile emulates it with the restart loop in `onend`.
    recognition.continuous = supportsContinuous();
    recognition.interimResults = true;
    recognition.lang = "en-US";

    // Set once a command has been handed off, so the trailing results of this
    // dying session are not re-matched against the wake word that just fired.
    let handedOff = false;

    recognition.onstart = () => {
      consecutiveErrorsRef.current = 0;
      listeningRef.current = true;
      setIsListening(true);
      setError(null);
    };

    /** Finish an activation: hand the command over and re-arm the recognizer. */
    const completeActivation = (submit: boolean) => {
      if (submit) {
        const cmd = extractCommand(commandBufferRef.current);
        if (cmd && cmd.length > 0) onCommandRef.current(cmd);
      }
      activatedRef.current = false;
      setIsActivated(false);
      setInterimText("");
      commandBufferRef.current = "";
      handedOff = true;
      try { recognition.stop(); } catch { /* ignore */ }
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (handedOff) return;

      // Committed and in-progress text are kept apart here. Concatenating every
      // entry in `results` is what produced the repeated-word transcripts on
      // phones, where each interim revision is appended rather than replacing
      // the previous one.
      const split = splitTranscript(event.results);
      const transcript = combinedTranscript(split);
      if (!transcript) return;

      if (activatedRef.current) {
        commandBufferRef.current = transcript;
        setInterimText(transcript);

        // Silence timer — fires when user stops speaking for commandSilenceMs
        clearSilenceTimer();
        silenceTimerRef.current = setTimeout(() => completeActivation(true), commandSilenceMs);
        return;
      }

      const recent = transcript.length > PASSIVE_WINDOW_CHARS
        ? transcript.slice(-PASSIVE_WINDOW_CHARS)
        : transcript;

      if (!containsWakeWord(recent)) return;

      activatedRef.current = true;
      setIsActivated(true);
      commandBufferRef.current = recent;
      setInterimText(recent);

      const immediateCmd = extractCommand(recent);
      clearSilenceTimer();
      if (immediateCmd && immediateCmd.length > 3) {
        // "gym buddy <command>" arrived in one breath — wait for them to finish.
        silenceTimerRef.current = setTimeout(() => completeActivation(true), commandSilenceMs);
      } else {
        // Wake word alone — give them longer to actually say something.
        silenceTimerRef.current = setTimeout(() => completeActivation(false), commandSilenceMs * 2);
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      listeningRef.current = false;
      setIsListening(false);

      if (
        destroyedRef.current ||
        !shouldListenRef.current ||
        suppressedRef.current ||
        pausedRef.current ||
        fatalRef.current
      ) {
        return;
      }

      // Both paths restart: an intentional stop re-arms after handling a command,
      // and an unintentional one is either Chrome's silence timeout or Android
      // ending the session after a single utterance.
      const backoff = Math.min(
        RESTART_MS * 2 ** consecutiveErrorsRef.current,
        MAX_RESTART_MS
      );
      startListening(backoff);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "no-speech" and "aborted" are routine — onend restarts us.
      if (event.error === "no-speech" || event.error === "aborted") return;

      if (isFatalSpeechError(event.error)) {
        fatalRef.current = true;
        setError(describeSpeechError(event.error));
        return;
      }
      // Transient (e.g. "network"): count it so onend backs off instead of
      // hammering the recognizer in a tight restart loop.
      consecutiveErrorsRef.current = Math.min(consecutiveErrorsRef.current + 1, 5);
      console.warn("[useWakeWord] Speech error:", event.error);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // Already started, or the mic is still held by something else — back off.
      consecutiveErrorsRef.current = Math.min(consecutiveErrorsRef.current + 1, 5);
      recognitionRef.current = null;
      startListening(Math.min(RESTART_MS * 2 ** consecutiveErrorsRef.current, MAX_RESTART_MS));
    }
  }, [commandSilenceMs, clearSilenceTimer]);

  const stopListening = useCallback(() => {
    clearSilenceTimer();
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    activatedRef.current = false;
    setIsActivated(false);
    setInterimText("");
    commandBufferRef.current = "";
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    listeningRef.current = false;
    setIsListening(false);
  }, [clearSilenceTimer]);

  // Start/stop based on enabled + suppressed
  useEffect(() => {
    const active = enabled && !suppressed && supported;
    // Both flags are set before anything is started or stopped, so the `onend`
    // that `abort()` triggers a moment later reads the intent of this run.
    shouldListenRef.current = active;
    destroyedRef.current = false; // reset on each effect run (handles re-mount)
    if (active) {
      // Settle first: coming out of `suppressed` means TTS just finished, and on a
      // phone the loudspeaker tail would otherwise be picked straight back up.
      startListening(RESUME_SETTLE_MS);
    } else {
      stopListening();
    }
    return () => {
      shouldListenRef.current = false;
      destroyedRef.current = true; // prevent ghost recognizer from restarting after unmount
      stopListening();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, suppressed, supported]);

  // Mobile browsers drop the microphone when the tab is backgrounded or the phone
  // is locked, and the recognizer never comes back on its own.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (listeningRef.current || !shouldListenRef.current) return;
      if (pausedRef.current || fatalRef.current) return;
      consecutiveErrorsRef.current = 0;
      startListening(RESTART_MS);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [startListening]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    stopListening();
  }, [stopListening]);

  const resume = useCallback(() => {
    pausedRef.current = false;
    consecutiveErrorsRef.current = 0;
    // startListening is a no-op unless listening is actually wanted right now.
    startListening(RESUME_SETTLE_MS);
  }, [startListening]);

  return { isListening, isActivated, interimText, supported, error, pause, resume };
}
