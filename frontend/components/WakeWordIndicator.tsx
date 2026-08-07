"use client";

import React from "react";
import { cn } from "@/lib/utils";

interface WakeWordIndicatorProps {
  isListening: boolean;
  isActivated: boolean;
  interimText: string;
  supported: boolean;
  isSpeaking: boolean;
  /** Set when listening stopped for a reason the user has to fix (e.g. mic blocked). */
  error?: string | null;
}

export default function WakeWordIndicator({
  isListening,
  isActivated,
  interimText,
  supported,
  isSpeaking,
  error = null,
}: WakeWordIndicatorProps) {
  if (!supported) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[999] flex flex-col items-end gap-2 pointer-events-none">
      {error && (
        <div
          role="alert"
          className="glass max-w-[280px] px-3 py-2 text-red-300 text-xs leading-snug animate-fadeIn"
        >
          {error}
        </div>
      )}

      {isActivated && interimText && (
        <div className="glass max-w-[280px] px-3 py-2 text-white text-xs leading-snug animate-fadeIn">
          {interimText}
        </div>
      )}

      <div
        className={cn(
          "flex items-center gap-1.5 px-3 py-1.5 rounded-full backdrop-blur-lg border transition-all duration-300",
          isActivated
            ? "bg-green-500/15 border-green-400/40"
            : isSpeaking
            ? "bg-blue-500/15 border-blue-400/30"
            : isListening
            ? "bg-white/8 border-white/15"
            : "bg-white/5 border-white/10"
        )}
      >
        <span
          className={cn(
            "w-2 h-2 rounded-full",
            isActivated
              ? "bg-green-400 animate-pulse"
              : isSpeaking
              ? "bg-blue-400"
              : isListening
              ? "bg-white/50 animate-pulse"
              : "bg-white/20"
          )}
        />
        <span
          className={cn(
            "text-[0.7rem] font-semibold tracking-wide",
            isActivated
              ? "text-green-300"
              : isSpeaking
              ? "text-blue-300"
              : isListening
              ? "text-white/60"
              : "text-white/30"
          )}
        >
          {isActivated
            ? "Listening..."
            : isSpeaking
            ? "Speaking..."
            : isListening
            ? 'Say "Gym Buddy"'
            : "Mic off"}
        </span>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn { animation: fadeIn 0.2s ease; }
      `}</style>
    </div>
  );
}
