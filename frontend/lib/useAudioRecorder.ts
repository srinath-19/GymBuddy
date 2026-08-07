"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Container preference for MediaRecorder.
//
// iOS Safari could only write MP4/AAC until 18.4 (March 2025), so mp4 has to stay
// in the list for older iPhones. Everything else prefers Opus-in-WebM, which is
// smaller and what the transcription endpoint expects by default.
// ---------------------------------------------------------------------------
const MIME_PREFERENCE = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/aac",
];

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of MIME_PREFERENCE) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // isTypeSupported throws rather than returning false on some older builds.
    }
  }
  return ""; // Let the browser fall back to its own default.
}

// ---------------------------------------------------------------------------
// Microphone acquisition.
//
// Audio processing hints are requested as `ideal` rather than as bare booleans.
// A bare boolean in the basic constraint set is *required*, and an Android device
// whose capture stack cannot offer (say) autoGainControl then matches no device
// at all — surfacing as NotFoundError, i.e. "no microphone", on a phone that
// plainly has one. Requesting them as ideal makes them advisory, and the bare
// `audio: true` retry covers stacks that reject the dictionary form outright.
// ---------------------------------------------------------------------------
const AUDIO_CONSTRAINTS: MediaStreamConstraints[] = [
  {
    audio: {
      // Matters far more on a phone than a laptop: the TTS reply plays out of
      // the loudspeaker straight back into the mic, and gyms are loud.
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
    },
  },
  { audio: true },
];

type MicResult = { stream: MediaStream } | { error: string };

function describeMicError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was denied. Enable it for this site in your browser settings.";
    case "NotFoundError":
      return "No microphone was found on this device.";
    case "NotReadableError":
      return "The microphone is already in use by another app. Close it and try again.";
    case "OverconstrainedError":
      return "This device's microphone could not be configured for recording.";
    default:
      // The DOMException name is included deliberately: without it, a failure on
      // a device we cannot reproduce locally is unattributable guesswork.
      return name
        ? `Could not start recording (${name}).`
        : "Could not start recording — microphone unavailable.";
  }
}

async function acquireMicrophone(): Promise<MicResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { error: "This browser cannot record audio." };
  }

  let lastError: unknown = null;
  for (const constraints of AUDIO_CONSTRAINTS) {
    try {
      return { stream: await navigator.mediaDevices.getUserMedia(constraints) };
    } catch (err) {
      lastError = err;
      // A denied permission will not be granted by relaxing the constraints, so
      // stop rather than prompting the user a second time.
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") break;
    }
  }
  return { error: describeMicError(lastError) };
}

/** Filename extension matching a recorder mime type — OpenAI parses the container from it. */
export function extensionForMimeType(mimeType: string): string {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  if (base.includes("webm")) return "webm";
  if (base.includes("ogg")) return "ogg";
  if (base.includes("mp4") || base.includes("m4a")) return "mp4";
  if (base.includes("aac")) return "aac";
  if (base.includes("mpeg")) return "mp3";
  if (base.includes("wav")) return "wav";
  return "webm";
}

interface UseAudioRecorderOptions {
  /** Hard cap on a single recording, so a stuck session cannot run away. */
  maxDurationMs?: number;
  /** Stop automatically after this much silence *following* detected speech. */
  silenceMs?: number;
  /** Fired when the recorder stopped itself (silence or max duration). */
  onAutoStop?: () => void;
}

/** Outcome of a start attempt. The failure message is returned rather than only
 *  set on state, because callers act on it in the same tick and would otherwise
 *  read the previous render's value. */
export type RecorderStartResult = { ok: true } | { ok: false; error: string };

interface UseAudioRecorderReturn {
  supported: boolean;
  isRecording: boolean;
  /** Begins capture. */
  start: () => Promise<RecorderStartResult>;
  /** Ends capture and resolves the recorded audio, or null if nothing was captured. */
  stop: () => Promise<Blob | null>;
  /** Ends capture and discards the audio. */
  cancel: () => void;
  /** Mime type the active (or most recent) recording was written with. */
  mimeType: string;
  error: string | null;
}

export function useAudioRecorder({
  maxDurationMs = 30_000,
  silenceMs = 2000,
  onAutoStop,
}: UseAudioRecorderOptions = {}): UseAudioRecorderReturn {
  const [supported, setSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [mimeType, setMimeType] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const resolveRef = useRef<((blob: Blob | null) => void) | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAutoStopRef = useRef(onAutoStop);

  // Silence detection state
  const audioCtxRef = useRef<AudioContext | null>(null);
  const monitorRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { onAutoStopRef.current = onAutoStop; }, [onAutoStop]);

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        typeof MediaRecorder !== "undefined" &&
        typeof navigator !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia
    );
  }, []);

  /** Releases the mic and analyser. Must run on every exit path, or the wake-word
   *  recognizer cannot reacquire the microphone afterwards. */
  const teardown = useCallback(() => {
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (monitorRef.current) {
      clearInterval(monitorRef.current);
      monitorRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => { /* already closed */ });
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    recorderRef.current = null;
  }, []);

  /**
   * Watches input level and stops once the speaker goes quiet.
   *
   * The threshold adapts to the observed peak because a gym is loud and the
   * browser's auto gain control lifts the noise floor — a fixed cutoff would
   * either never fire indoors or fire mid-sentence.
   */
  const startSilenceMonitor = useCallback(
    (stream: MediaStream, onSilent: () => void) => {
      let ctx: AudioContext;
      try {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        ctx = new Ctor();
      } catch {
        return; // No analyser available — the max-duration cap still applies.
      }
      audioCtxRef.current = ctx;
      void ctx.resume().catch(() => { /* resumed by the click that started us */ });

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);

      const samples = new Uint8Array(analyser.fftSize);
      let peak = 0;
      let heardSpeech = false;
      let quietSince = 0;

      monitorRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let sumSquares = 0;
        for (let i = 0; i < samples.length; i++) {
          const centered = (samples[i] - 128) / 128;
          sumSquares += centered * centered;
        }
        const rms = Math.sqrt(sumSquares / samples.length);

        peak = Math.max(peak, rms);
        const threshold = Math.max(0.015, peak * 0.25);

        if (rms >= threshold) {
          heardSpeech = true;
          quietSince = 0;
          return;
        }
        // Only arm the timer once the user has actually said something, so the
        // pause between tapping the button and starting to talk never cuts them off.
        if (!heardSpeech) return;
        if (quietSince === 0) {
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= silenceMs) {
          onSilent();
        }
      }, 100);
    },
    [silenceMs]
  );

  const finish = useCallback((): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      teardown();
      setIsRecording(false);
      return Promise.resolve(null);
    }
    return new Promise<Blob | null>((resolve) => {
      resolveRef.current = resolve;
      try {
        recorder.stop(); // onstop resolves and tears down
      } catch {
        teardown();
        setIsRecording(false);
        resolve(null);
      }
    });
  }, [teardown]);

  const stop = useCallback(() => finish(), [finish]);

  const cancel = useCallback(() => {
    resolveRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* already stopped */ }
    }
    chunksRef.current = [];
    teardown();
    setIsRecording(false);
  }, [teardown]);

  const start = useCallback(async (): Promise<RecorderStartResult> => {
    if (recorderRef.current) return { ok: false, error: "Already recording." };
    setError(null);

    const fail = (message: string): RecorderStartResult => {
      setError(message);
      return { ok: false, error: message };
    };

    const mic = await acquireMicrophone();
    if ("error" in mic) return fail(mic.error);
    const stream = mic.stream;

    const type = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    } catch {
      for (const track of stream.getTracks()) track.stop();
      return fail("This browser cannot record audio.");
    }

    streamRef.current = stream;
    recorderRef.current = recorder;
    chunksRef.current = [];
    setMimeType(recorder.mimeType || type);

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    };

    recorder.onstop = () => {
      const blob = chunksRef.current.length
        ? new Blob(chunksRef.current, { type: recorder.mimeType || type || "audio/webm" })
        : null;
      chunksRef.current = [];
      teardown();
      setIsRecording(false);
      const resolve = resolveRef.current;
      resolveRef.current = null;
      resolve?.(blob);
    };

    recorder.onerror = () => {
      setError("Recording failed.");
      cancel();
    };

    const autoStop = () => {
      if (!recorderRef.current) return;
      onAutoStopRef.current?.();
    };

    try {
      recorder.start();
    } catch {
      teardown();
      return fail("Could not start recording.");
    }

    setIsRecording(true);
    maxTimerRef.current = setTimeout(autoStop, maxDurationMs);
    startSilenceMonitor(stream, autoStop);
    return { ok: true };
  }, [cancel, maxDurationMs, startSilenceMonitor, teardown]);

  // Release the mic if the component goes away mid-recording.
  useEffect(() => () => { teardown(); }, [teardown]);

  return { supported, isRecording, start, stop, cancel, mimeType, error };
}
