// lib/feedback.ts — pure validation for per-audit feedback (no next/server), so it is unit-testable.
//
// A feedback submission carries ONLY the rating, the reason chips, an optional free-text comment,
// and an audit id. It NEVER carries the audited clinical input — that text is not accepted here.
import { z } from "zod";

// The canonical reason chips (mirrored in components/AuditShell.tsx). Free-text "Other" detail is
// captured via `comment`.
export const FEEDBACK_REASONS = [
  "Missed a real problem",
  "False alarm — flagged something fine",
  "Citation result wrong",
  "Drug/medication result wrong",
  "Verdict too harsh",
  "Verdict too lenient",
  "Confusing or unclear",
  "Too slow",
  "Other",
] as const;

// A thumbs-DOWN must carry at least one reason chip OR a non-empty comment; a thumbs-UP needs
// neither. reasons is free-form strings (not an enum) so the client and server can evolve the chip
// list independently — the server stores whatever chips it is given, capped in length and count.
export const FeedbackSchema = z
  .object({
    audit_id: z.string().max(64).nullish(),
    rating: z.enum(["up", "down"]),
    reasons: z.array(z.string().max(80)).max(12).optional().default([]),
    comment: z.string().max(1000).optional(),
  })
  .refine(
    (v) => v.rating === "up" || v.reasons.length > 0 || !!(v.comment && v.comment.trim().length > 0),
    { message: "A thumbs-down needs at least one reason or a comment.", path: ["reasons"] }
  );

export type FeedbackInput = z.infer<typeof FeedbackSchema>;
