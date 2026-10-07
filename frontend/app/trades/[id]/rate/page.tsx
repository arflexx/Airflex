"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getToken } from "../../../lib/auth";
import { ApiError, apiFetch } from "../../../lib/apiFetch";
import { Button } from "../../../../components/ui/Button";

export default function RateSellerPage() {
  const params = useParams();
  const router = useRouter();
  const tradeId = params.id as string;

  const [stars, setStars] = useState(5);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const token = getToken();
    if (!token) {
      router.push(`/auth/signup?returnTo=${encodeURIComponent(`/trades/${tradeId}/rate`)}`);
      return;
    }

    try {
      await apiFetch(`/api/trades/${tradeId}/rate`, {
        method: "POST",
        body: JSON.stringify({ stars, comment: comment.trim() || undefined }),
      });
      router.push(`/trades/${tradeId}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setError("You have already rated this trade.");
      } else if (error instanceof ApiError) {
        setError(error.message ?? "Could not submit rating.");
      } else {
        setError("Network error. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-lg px-4 py-10">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Rate this seller</h1>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        Share feedback about your completed trade. Ratings help other buyers choose trusted sellers.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-6">
        <label className="flex flex-col gap-2 text-sm font-medium">
          Stars (1–5)
          <input
            type="number"
            min={1}
            max={5}
            value={stars}
            onChange={(e) => setStars(Number(e.target.value))}
            className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-800"
            required
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium">
          Comment (optional)
          <textarea
            maxLength={300}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-800"
            placeholder="What went well?"
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <Button type="submit" isLoading={submitting} loadingText="Submitting…">
          Submit rating
        </Button>
      </form>
    </main>
  );
}
