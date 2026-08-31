import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * An asynchronous Express request handler that returns a Promise.
 */
export type AsyncRequestHandler<
  P = any,
  ResBody = any,
  ReqBody = any,
  ReqQuery = any,
  Locals extends Record<string, any> = Record<string, any>
> = (
  req: Request<P, ResBody, ReqBody, ReqQuery, Locals>,
  res: Response<ResBody, Locals>,
  next: NextFunction
) => Promise<any>;

/**
 * Wraps an asynchronous Express route handler to catch any rejected promises or
 * thrown errors and forward them to Express's next() error handler.
 *
 * @deprecated Superseded by `express-async-errors`. This wrapper provides interim
 * protection and should be deprecated once `express-async-errors` is fully verified
 * and active across all environments.
 *
 * @template P - Path parameters dictionary type
 * @template ResBody - Response body type
 * @template ReqBody - Request body type
 * @template ReqQuery - Query parameters type
 * @template Locals - Response locals type
 *
 * @param fn - The asynchronous route handler to wrap
 * @returns Standard Express RequestHandler that catches errors and calls next(err)
 */
export function asyncHandler<
  P = any,
  ResBody = any,
  ReqBody = any,
  ReqQuery = any,
  Locals extends Record<string, any> = Record<string, any>
>(
  fn: AsyncRequestHandler<P, ResBody, ReqBody, ReqQuery, Locals>
): RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals> {
  return (req, res, next) => {
    // Handle both rejected promises and synchronously thrown errors inside fn
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (err) {
      next(err);
    }
  };
}

export default asyncHandler;
