import { useEffect, useState, type ReactNode } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { AlertCircle, Loader2, Lock } from 'lucide-react';
import { ACCESS_DENIED_MESSAGE } from '../../shared/authConfig.ts';
import {
  auth,
  isAuthorizedUser,
  isFirebaseConfigured,
  signInWithGooglePopup,
  signOutUser,
} from '../lib/firebase.ts';
import { BRAND_LOGO_URL } from '../lib/brand.ts';

interface AuthGateProps {
  children: (props: { user: User; onSignOut: () => Promise<void> }) => ReactNode;
}

type AuthStatus = 'checking' | 'signed_out' | 'authorized';

function GoogleLogoIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
      />
    </svg>
  );
}

function StudioBrandLockup() {
  return (
    <div className="flex items-center justify-center gap-3">
      <img
        src={BRAND_LOGO_URL}
        alt="SarYay"
        width={40}
        height={40}
        className="h-10 w-10 shrink-0 rounded-full border border-[#E5E7EB] bg-white object-cover"
      />
      <span className="text-xl font-semibold tracking-tight text-[#111827]">SarYay</span>
    </div>
  );
}

export function AuthGate({ children }: AuthGateProps) {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [user, setUser] = useState<User | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setStatus('signed_out');
      setAuthError(
        'Firebase authentication is not configured. Please check your Firebase configuration keys.',
      );
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      if (!nextUser) {
        setUser(null);
        setStatus('signed_out');
        return;
      }

      if (isAuthorizedUser(nextUser)) {
        setUser(nextUser);
        setAuthError(null);
        setStatus('authorized');
      } else {
        // Immediately revoke unauthorized session and block access to UI & API
        setUser(null);
        setStatus('signed_out');
        setAuthError(ACCESS_DENIED_MESSAGE);
        try {
          await signOutUser();
        } catch {
          // Session already cleared from local state
        }
      }
    });

    return () => unsubscribe();
  }, []);

  const handleGoogleSignIn = async () => {
    if (isSigningIn) return;
    setAuthError(null);
    setIsSigningIn(true);

    try {
      const signedInUser = await signInWithGooglePopup();
      if (!isAuthorizedUser(signedInUser)) {
        await signOutUser();
        setUser(null);
        setStatus('signed_out');
        setAuthError(ACCESS_DENIED_MESSAGE);
      } else {
        setUser(signedInUser);
        setStatus('authorized');
      }
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        // User intentionally closed sign-in popup
      } else if (code === 'auth/unauthorized-domain') {
        setAuthError(
          `This domain (${window.location.hostname}) is not authorized in Firebase Console yet. Add it under Authentication → Settings → Authorized domains.`,
        );
      } else if (code === 'auth/popup-blocked') {
        setAuthError(
          'The Google sign-in popup was blocked by your browser. Please allow popups for this site and try again.',
        );
      } else {
        setAuthError('Could not complete Google Sign-In. Please try again.');
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    setAuthError(null);
    await signOutUser();
    setUser(null);
    setStatus('signed_out');
  };

  // Prevent any flash of protected workspace while checking auth state
  if (status === 'checking') {
    return (
      <div className="safe-top safe-bottom flex min-h-[100dvh] w-full flex-col items-center justify-center bg-white px-6 text-[#111827]">
        <div className="flex flex-col items-center gap-3.5 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-[#4338CA]" aria-hidden="true" />
          <p className="text-sm font-medium text-[#6B7280]">Checking workspace access…</p>
        </div>
      </div>
    );
  }

  if (status === 'authorized' && user) {
    return <>{children({ user, onSignOut: handleSignOut })}</>;
  }

  return (
    <div className="safe-top safe-bottom flex min-h-[100dvh] w-full flex-col items-center justify-center bg-white px-5 py-10 text-[#111827] sm:px-6 sm:py-12">
      <div className="w-full max-w-[420px] rounded-2xl border border-[#E5E7EB] bg-white p-7 sm:p-10">
        <StudioBrandLockup />

        <div className="mt-5 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-[#111827] [text-wrap:balance]">
            Personal Voice &amp; Story Studio
          </h1>
          <p className="mt-2.5 text-sm leading-relaxed text-[#6B7280]">
            A private Burmese and English dictation and literary writing workspace. Sign in with an
            authorized Google account to continue.
          </p>
        </div>

        {authError && (
          <div
            role="alert"
            className="mt-6 flex items-start gap-2.5 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-left text-xs leading-relaxed text-[#991B1B]"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
            <p>{authError}</p>
          </div>
        )}

        <div className="mt-7">
          <button
            type="button"
            disabled={isSigningIn || !isFirebaseConfigured}
            onClick={handleGoogleSignIn}
            className="flex w-full items-center justify-center gap-3 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-5 py-3 text-sm font-medium text-[#111827] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-wait disabled:opacity-65"
          >
            {isSigningIn ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-[#4338CA]" />
                <span>Signing in…</span>
              </>
            ) : (
              <>
                <GoogleLogoIcon />
                <span>Continue with Google</span>
              </>
            )}
          </button>
        </div>

        <div className="mt-6 flex items-center justify-center gap-1.5 border-t border-[#F3F4F6] pt-5 text-xs text-[#6B7280]">
          <Lock className="h-3.5 w-3.5 shrink-0 text-[#9CA3AF]" aria-hidden="true" />
          <span>Protected by Google Sign-In</span>
        </div>
      </div>
    </div>
  );
}
