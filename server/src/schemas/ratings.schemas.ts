import { z } from "zod";

export const createRatingSchema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().max(300).optional(),
});

export type CreateRatingInput = z.infer<typeof createRatingSchema>;

export const userRatingsPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
