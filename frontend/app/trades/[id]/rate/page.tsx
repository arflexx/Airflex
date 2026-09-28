"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getToken } from "../../../lib/auth";
import { Button } from "../../../../components/ui/Button";

export default function RateSellerPage() {
  const params = useParams();
  const router = useRouter();
  const tradeId = params.id as string;

  const [stars, setStars] = useState(5);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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
      const res = await fetch(`${apiUrl}/api/trades/${tradeId}/rate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ stars, comment: comment.trim() || undefined }),
      });

      const data = (await res.json()) as { error?: string };

      if (res.status === 409) {
        setError("You have already rated this trade.");
        return;
      }

      if (!res.ok) {
        setError(data.error ?? "Could not submit rating.");
        return;
      }

      router.push(`/trades/${tradeId}`);
    } catch {
      setError("Network error. Please try again.");
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
