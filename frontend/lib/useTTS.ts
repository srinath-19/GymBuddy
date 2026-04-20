"use client";

import { useCallback, useRef, useState } from "react";
import { createClient } from "./supabase/client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface UseTTSOptions {
  /** Voice to use (default "echo") */
  voice?: string;
  /** Called when TTS starts playing */
  onStart?: () => void;
  /** Called when TTS finishes playing */
  onEnd?: () => void;
}

interface UseTTSReturn {
  /** Speak the given text via OpenAI TTS, with browser fallback */
  speak: (text: string) => void;
  /** Play audio from a base64-encoded MP3 string (already fetched by the backend) */
  speakFromBase64: (b64: string) => void;
  /** Whether audio is currently playing */
  isSpeaking: boolean;
  /** Stop any currently playing audio */
  stop: () => void;
}

async function getToken(): Promise<string> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error("Not authenticated");
  return data.session.access_token;
}

export function useTTS({
  voice = "echo",
  onStart,
  onEnd,
}: UseTTSOptions = {}): UseTTSReturn {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const onStartRef = useRef(onStart);
  const onEndRef = useRef(onEnd);

  onStartRef.current = onStart;
  onEndRef.current = onEnd;

  const cleanup = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const speakWithBrowserFallback = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !window.speechSynthesis) {
        setIsSpeaking(false);
        onEndRef.current?.();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      utterance.volume = 0.9;
      utterance.onstart = () => {
        setIsSpeaking(true);
        onStartRef.current?.();
      };
      utterance.onend = () => {
        setIsSpeaking(false);
        onEndRef.current?.();
      };
      utterance.onerror = () => {
        setIsSpeaking(false);
        onEndRef.current?.();
      };
      window.speechSynthesis.speak(utterance);
    },
    []
  );

  const speak = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      // Stop any currently playing audio
      cleanup();

      // Cancel any browser speech in progress
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }

      setIsSpeaking(true);
      onStartRef.current?.();

      try {
        const token = await getToken();
        const response = await fetch(`${API_BASE}/api/v1/tts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ text, voice }),
        });

        if (!response.ok) {
          throw new Error(`TTS HTTP ${response.status}`);
        }

        // Collect MP3 chunks into a Blob
        const reader = response.body!.getReader();
        const chunks: ArrayBuffer[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value.buffer as ArrayBuffer);
        }

        const blob = new Blob(chunks, { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        urlRef.current = url;

        const audio = new Audio(url);
        audioRef.current = audio;

        audio.onended = () => {
          setIsSpeaking(false);
          cleanup();
          onEndRef.current?.();
        };

        audio.onerror = () => {
          console.warn("[useTTS] Audio playback error, falling back to browser TTS");
          cleanup();
          speakWithBrowserFallback(text);
        };

        await audio.play();
      } catch (err) {
        console.warn("[useTTS] OpenAI TTS failed, falling back to browser TTS:", err);
        cleanup();
        speakWithBrowserFallback(text);
      }
    },
    [voice, cleanup, speakWithBrowserFallback]
  );

  const speakFromBase64 = useCallback(
    (b64: string) => {
      if (!b64) return;
      cleanup();
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }

      try {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        urlRef.current = url;

        const audio = new Audio(url);
        audioRef.current = audio;

        setIsSpeaking(true);
        onStartRef.current?.();

        audio.onended = () => {
          setIsSpeaking(false);
          cleanup();
          onEndRef.current?.();
        };
        audio.onerror = () => {
          setIsSpeaking(false);
          cleanup();
          onEndRef.current?.();
        };

        audio.play().catch(() => {
          setIsSpeaking(false);
          cleanup();
          onEndRef.current?.();
        });
      } catch {
        setIsSpeaking(false);
        onEndRef.current?.();
      }
    },
    [cleanup]
  );

  const stop = useCallback(() => {
    cleanup();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
    onEndRef.current?.();
  }, [cleanup]);

  return { speak, speakFromBase64, isSpeaking, stop };
}
