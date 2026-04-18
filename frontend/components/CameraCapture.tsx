"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resizeImageToBase64 } from "@/lib/coach-api";

interface CameraCaptureProps {
  onCapture: (base64: string) => void;
  onClose: () => void;
}

export default function CameraCapture({ onCapture, onClose }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Start camera stream
  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => {
        if (!cancelled) setError("Camera access denied or unavailable.");
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const handleCapture = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const MAX = 1024;
    let w = video.videoWidth;
    let h = video.videoHeight;
    if (w > MAX || h > MAX) {
      if (w >= h) { h = Math.round((h * MAX) / w); w = MAX; }
      else { w = Math.round((w * MAX) / h); h = MAX; }
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(video, 0, 0, w, h);
    const base64 = canvas.toDataURL("image/jpeg", 0.85);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    onCapture(base64);
  }, [onCapture]);

  return (
    <div style={{
      position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.75)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, padding: "1rem",
    }}>
      <div style={{
        backgroundColor: "white", borderRadius: "0.75rem", overflow: "hidden",
        width: "100%", maxWidth: "480px",
      }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.75rem 1rem", borderBottom: "1px solid #e5e7eb" }}>
          <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Take a photo</span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1.1rem", color: "#6b7280" }}>✕</button>
        </div>

        {error ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "#dc2626", fontSize: "0.875rem" }}>
            {error}
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{ width: "100%", display: "block", maxHeight: "300px", objectFit: "cover", backgroundColor: "#000" }}
            />
            <div style={{ padding: "0.75rem", display: "flex", justifyContent: "center" }}>
              <button
                onClick={handleCapture}
                style={{
                  padding: "0.5rem 1.5rem",
                  backgroundColor: "#111827", color: "white",
                  border: "none", borderRadius: "0.375rem",
                  fontSize: "0.875rem", fontWeight: 600, cursor: "pointer",
                }}
              >
                Capture
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Helper: resize a File from the file input and return base64. */
export { resizeImageToBase64 };
