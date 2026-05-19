import { SignInButton, SignUpButton, UserButton, useAuth, useClerk } from "@clerk/react";
import { LogOut } from "lucide-react";
import { useEffect, useRef } from "react";
import { createClerkSession } from "./api";
import { CLERK_PUBLISHABLE_KEY } from "./authConfig";
import type { AuthState } from "./types";

export function ClerkLoginPanel({
  error,
  onAuthenticated,
  onError
}: {
  error: string;
  onAuthenticated: () => Promise<void>;
  onError: (error: string) => void;
}) {
  if (!CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="login-panel auth-error-panel">
        <div>
          <p className="eyebrow">Clerk auth</p>
          <h1>Missing publishable key</h1>
        </div>
        <p className="error-text">Set VITE_CLERK_PUBLISHABLE_KEY for the client when Clerk auth is enabled on the server.</p>
      </div>
    );
  }
  return <ClerkLoginPanelInner error={error} onAuthenticated={onAuthenticated} onError={onError} />;
}

function ClerkLoginPanelInner({
  error,
  onAuthenticated,
  onError
}: {
  error: string;
  onAuthenticated: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const exchangeInFlightRef = useRef(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || exchangeInFlightRef.current) {
      return;
    }
    exchangeInFlightRef.current = true;
    onError("");
    getToken()
      .then((token) => {
        if (!token) {
          throw new Error("Clerk did not return a session token.");
        }
        return createClerkSession(token);
      })
      .then(onAuthenticated)
      .catch((err) => {
        exchangeInFlightRef.current = false;
        onError(messageFromError(err));
      });
  }, [getToken, isLoaded, isSignedIn, onAuthenticated, onError]);

  return (
    <div className="login-panel">
      <div>
        <p className="eyebrow">Clerk OAuth</p>
        <h1>Codex Web UI</h1>
      </div>
      <p className="muted">Sign in with Clerk. Access is allowed only for users with active Clerk metadata.</p>
      <div className="clerk-login-actions">
        <SignInButton mode="modal">
          <button className="primary-button" type="button">Sign in</button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button className="secondary-button" type="button">Register</button>
        </SignUpButton>
        {isSignedIn && <UserButton />}
      </div>
      <p className="error-text">{error || (isSignedIn ? "Checking account access..." : "")}</p>
    </div>
  );
}

export function LogoutButton({ authMode, onLogout }: { authMode: AuthState["mode"]; onLogout: () => Promise<void> }) {
  if (authMode === "clerk" && CLERK_PUBLISHABLE_KEY) {
    return <ClerkLogoutButton onLogout={onLogout} />;
  }
  return (
    <button className="ghost-button" type="button" onClick={onLogout}>
      <LogOut size={16} /> Logout
    </button>
  );
}

function ClerkLogoutButton({ onLogout }: { onLogout: () => Promise<void> }) {
  const { signOut } = useClerk();
  return (
    <button
      className="ghost-button"
      type="button"
      onClick={async () => {
        await onLogout();
        await signOut();
      }}
    >
      <LogOut size={16} /> Logout
    </button>
  );
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
