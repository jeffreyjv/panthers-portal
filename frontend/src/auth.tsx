import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { CurrentUser, fetchMe, logout as logoutRequest } from "./api";

interface AuthState {
  user: CurrentUser | null;
  /** True until the first /api/auth/me settles. Distinct from "signed out":
   *  rendering the signed-out prompt before we know would flash it at people
   *  who are in fact signed in. */
  loading: boolean;
  signIn: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Strips the ?auth=... marker the OAuth callback lands with.
 *
 * Without this it survives every later navigation and a refresh would re-show
 * whatever banner it triggered.
 */
function takeAuthResult(): string | null {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("auth");
  if (result) {
    params.delete("auth");
    const query = params.toString();
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (query ? `?${query}` : ""),
    );
  }
  return result;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetchMe()
      .then((me) => active && setUser(me))
      // A failed lookup means "not signed in" as far as the UI is concerned;
      // there is nothing useful to say about it beyond that.
      .catch(() => active && setUser(null))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  // A full navigation, not fetch: Google's consent screen is a page the user
  // has to see and interact with, and it refuses to be framed or XHR'd.
  const signIn = useCallback(() => {
    window.location.href = "/api/auth/google";
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      // Clear locally even if the request failed — the alternative is a UI
      // that claims you're still signed in after you asked not to be.
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** One-shot read of how the last sign-in attempt went, for a banner. */
export function useAuthResult(): string | null {
  const [result] = useState(takeAuthResult);
  return result;
}
