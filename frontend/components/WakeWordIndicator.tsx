"use client";

import React from "react";

interface WakeWordIndicatorProps {
  isListening: boolean;
  isActivated: boolean;
  interimText: string;
  supported: boolean;
  isSpeaking: boolean;
}

/**
 * Floating indicator showing wake-word listening state.
 * Shows a pulsing mic when listening, a green active state when
 * the wake word is detected, and the interim transcript.
 */
export default function WakeWordIndicator({
  isListening,
  isActivated,
  interimText,
  supported,
  isSpeaking,
}: WakeWordIndicatorProps) {
  if (!supported) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "1.5rem",
        right: "1.5rem",
        zIndex: 999,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: "0.5rem",
        pointerEvents: "none",
      }}
    >
      {/* Interim text bubble — shown when activated */}
      {isActivated && interimText && (
        <div
          style={{
            maxWidth: "280px",
            padding: "0.5rem 0.75rem",
            backgroundColor: "rgba(17, 24, 39, 0.9)",
            color: "white",
            fontSize: "0.8rem",
            borderRadius: "0.625rem",
            lineHeight: 1.4,
            backdropFilter: "blur(8px)",
            animation: "fadeIn 0.2s ease",
          }}
        >
          {interimText}
        </div>
      )}

      {/* Mic indicator pill */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          padding: "0.4rem 0.75rem",
          borderRadius: "9999px",
          backgroundColor: isActivated
            ? "rgba(34, 197, 94, 0.15)"
            : isSpeaking
            ? "rgba(59, 130, 246, 0.1)"
            : isListening
            ? "rgba(17, 24, 39, 0.08)"
            : "rgba(17, 24, 39, 0.05)",
          border: `1px solid ${
            isActivated
              ? "rgba(34, 197, 94, 0.3)"
              : isSpeaking
              ? "rgba(59, 130, 246, 0.2)"
              : "rgba(17, 24, 39, 0.1)"
          }`,
          backdropFilter: "blur(8px)",
          transition: "all 0.3s ease",
        }}
      >
        {/* Pulsing dot */}
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            backgroundColor: isActivated
              ? "#22c55e"
              : isSpeaking
              ? "#3b82f6"
              : isListening
              ? "#6b7280"
              : "#d1d5db",
            animation: isActivated
              ? "pulse 1s ease-in-out infinite"
              : isListening
              ? "pulse 2s ease-in-out infinite"
              : "none",
          }}
        />
        <span
          style={{
            fontSize: "0.7rem",
            fontWeight: 600,
            color: isActivated
              ? "#15803d"
              : isSpeaking
              ? "#2563eb"
              : isListening
              ? "#6b7280"
              : "#9ca3af",
            letterSpacing: "0.03em",
          }}
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

      {/* Inline CSS animations */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.3); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
