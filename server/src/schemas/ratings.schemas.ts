import { z } from "zod";

export const createRatingSchema = z.object({
  stars: z.number().int().min(1).max(5),
  // `nullish` (not just optional): clients commonly serialise "no comment" as
  // an explicit null in JSON, and the route persists `comment ?? null` either
  // way, so an explicit null must not be rejected as a validation error.
  comment: z.string().max(300).nullish(),
});

export type CreateRatingInput = z.infer<typeof createRatingSchema>;

export const userRatingsPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
