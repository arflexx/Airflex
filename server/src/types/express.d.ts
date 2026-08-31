// Uses TypeScript declaration merging to augment Express types globally:
// https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        phone: string;
        role: string;
        iat: number;
        exp: number;
        sub?: string;
        stellarPublicKey?: string;
      };
    }

    interface Locals {
      requestId: string;
    }
  }
}

export {};
