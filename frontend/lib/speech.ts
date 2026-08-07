"use client";

import type {
  SpeechRecognitionConstructor,
  SpeechRecognitionResultList,
} from "@/lib/speech-types";
import "@/lib/speech-types";

// ---------------------------------------------------------------------------
// Shared Web Speech helpers.
//
// The desktop and mobile implementations of this API are not the same engine:
// desktop Chrome streams to Google's cloud recognizer, Android Chrome delegates
// to the on-device Android SpeechRecognizer, and iOS Safari delegates to Siri
// dictation. The mobile engines differ in ways that break naive result handling,
// so every consumer goes through these helpers rather than reading `results`
// directly.
// ---------------------------------------------------------------------------

export function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/** Chromium's User-Agent Client Hints. Not in lib.dom, and absent on Safari/Firefox. */
interface NavigatorUAData {
  mobile: boolean;
}

/**
 * True on phones and tablets.
 *
 * Checked in three steps, most reliable first:
 *  1. `navigator.userAgentData.mobile` — the standards-track answer, and the only
 *     one that stays correct when Android's "Request desktop site" rewrites the
 *     user agent string. Chromium only, which covers Android Chrome.
 *  2. The user agent string, for Safari and Firefox.
 *  3. iPadOS 13+ reports a desktop Mac user agent, so it is identified by the
 *     fact that no real Mac reports multiple touch points.
 */
export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;

  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
  if (typeof uaData?.mobile === "boolean") return uaData.mobile;

  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

/** iOS/iPadOS, where MediaRecorder could not write WebM before Safari 18.4. */
export function isAppleMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

/**
 * Joins transcript segments, dropping consecutive repeats.
 *
 * Mobile recognizers sometimes re-emit an utterance verbatim as a second final
 * result, which would otherwise show up as doubled text.
 */
function joinSegments(segments: string[]): string {
  const out: string[] = [];
  for (const segment of segments) {
    const text = segment.trim();
    if (!text) continue;
    if (out.length > 0 && out[out.length - 1].toLowerCase() === text.toLowerCase()) {
      continue;
    }
    out.push(text);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

export interface SplitTranscript {
  /** Committed text — safe to submit. */
  final: string;
  /** In-progress text — safe to display, never to submit. */
  interim: string;
}

/**
 * Separates committed results from in-progress ones.
 *
 * This is the fix for the duplicated-transcript bug on phones. Desktop Chrome
 * *replaces* an interim result in place as it revises it, so naively joining
 * every entry in `results` happens to produce clean text. Android Chrome and iOS
 * Safari instead *append* each revision as a new entry, so the same join yields
 * "bench press bench press 3 bench press 3 by 10". Committing only `isFinal`
 * results, and previewing only the most recent interim one, is correct on both.
 *
 * @param fromIndex Index to start reading from, so callers driving a long-lived
 *   session can skip results they have already consumed.
 */
export function splitTranscript(
  results: SpeechRecognitionResultList,
  fromIndex = 0
): SplitTranscript {
  const finals: string[] = [];
  let latestInterim = "";

  for (let i = Math.max(0, fromIndex); i < results.length; i++) {
    const result = results[i];
    const text = result?.[0]?.transcript ?? "";
    if (!text.trim()) continue;

    if (result.isFinal) {
      finals.push(text);
      // Anything interim seen so far described this same utterance, and the final
      // result supersedes it. Mobile leaves those stale revisions in the list, so
      // keeping them would re-append text that was already committed.
      latestInterim = "";
    } else {
      // Only the newest interim entry matters; earlier ones are stale revisions
      // of the same words on mobile, and already superseded on desktop.
      latestInterim = text;
    }
  }

  return { final: joinSegments(finals), interim: latestInterim.trim() };
}

/** Final plus interim text, for matching against speech that is still arriving. */
export function combinedTranscript(split: SplitTranscript): string {
  return [split.final, split.interim].filter(Boolean).join(" ").trim();
}

/**
 * Android's SpeechRecognizer has no continuous mode — Chromium bug 40324711.
 * Requesting it there yields a session that dies after one utterance anyway (or,
 * worse, one that never fires `onend`), so continuous recognition is emulated by
 * restarting instead.
 */
export function supportsContinuous(): boolean {
  return !isMobileBrowser();
}

/** Human-readable reason for a SpeechRecognitionErrorEvent's `error` code. */
export function describeSpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Enable it for this site in your browser settings.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Speech recognition lost its network connection.";
    case "language-not-supported":
      return "This browser cannot recognize the selected language.";
    default:
      return `Speech recognition error: ${code}`;
  }
}

/** Error codes that mean retrying will not help until the user intervenes. */
export function isFatalSpeechError(code: string): boolean {
  return code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture";
}
