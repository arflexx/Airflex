"use client";

/**
 * AuthContext — application-wide authentication state.
 *
 * Backed by the JWT stored in localStorage via the utilities in `lib/auth.ts`.
 * On mount the provider reads any persisted token + user, then immediately sets
 * `isLoading: false` — no network call is made. The token is decoded only for
 * the client-side display; server-side route protection is still handled by the
 * Next.js middleware using the Authorization cookie.
 *
 * Shape:
 *   user        — the StoredUser parsed from localStorage, or null
 *   token       — the raw JWT from localStorage, or null
 *   role        — the account role decoded from the JWT payload, falling back
 *                 to the stored user; null when signed out
 *   login(token, user) — persist + hydrate state
 *   logout()    — clear storage + reset state
 *   isLoading   — true only during the initial mount hydration tick
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  clearToken,
  getToken,
  getUser,
  readRole,
  saveToken,
  saveUser,
  type StoredUser,
  type UserRole,
} from "../lib/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { StoredUser as User, UserRole };

export interface AuthContextValue {
  user: StoredUser | null;
  token: string | null;
  /**
   * Account role decoded from the JWT payload (fallback: the stored user's
   * `role`). `null` when signed out or when neither source carries a valid
   * role. A rendering hint only — never trust it as authorisation; the server
   * re-checks the role on every admin endpoint.
   */
  role: UserRole | null;
  /** Persist `token` and `user` then update context state. */
  login: (token: string, user: StoredUser) => void;
  /** Clear persisted credentials and reset context state. */
  logout: () => void;
  /** `true` only during the initial localStorage hydration. */
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const AuthContext = createContext<AuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]       = useState<StoredUser | null>(null);
  const [token, setToken]     = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Hydrate from localStorage on first mount (client only).
  useEffect(() => {
    const storedToken = getToken();
    const storedUser  = getUser();

    if (storedToken && storedUser) {
      setToken(storedToken);
      setUser(storedUser);
    }

    setIsLoading(false);
  }, []);

  /** Persist and set credentials in state. */
  const login = useCallback((newToken: string, newUser: StoredUser) => {
    saveToken(newToken);
    saveUser(newUser);
    setToken(newToken);
    setUser(newUser);
  }, []);

  /** Clear credentials from storage and state. */
  const logout = useCallback(() => {
    clearToken(); // clears both TOKEN_KEY and USER_KEY
    setToken(null);
    setUser(null);
  }, []);

  // Derived from the JWT payload, falling back to the stored user's role.
  // Recomputed whenever either changes, so login/logout/hydration stay in sync.
  const role = useMemo(
    () => readRole(token) ?? user?.role ?? null,
    [token, user],
  );

  return (
    <AuthContext.Provider value={{ user, token, role, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}
