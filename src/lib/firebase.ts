import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import firebaseAppletConfig from '../../firebase-applet-config.json';
import { isEmailAuthorized, parseAllowedEmails } from '../../shared/authConfig.ts';

/**
 * Firebase Web Configuration
 *
 * By default, this loads the provisioned Firebase project from `firebase-applet-config.json`.
 * To use a different Firebase project (e.g., on Netlify), set the VITE_FIREBASE_*
 * environment variables or update `firebase-applet-config.json`.
 */
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || firebaseAppletConfig.apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || firebaseAppletConfig.authDomain,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || firebaseAppletConfig.projectId,
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || firebaseAppletConfig.storageBucket,
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || firebaseAppletConfig.messagingSenderId,
  appId: import.meta.env.VITE_FIREBASE_APP_ID || firebaseAppletConfig.appId,
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId,
);

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: 'select_account',
});

export function getClientAllowedEmails(): string[] {
  return parseAllowedEmails(import.meta.env.VITE_ALLOWED_EMAIL);
}

export function isAuthorizedUser(user: User | null): boolean {
  if (!user || !user.email) return false;
  return isEmailAuthorized(user.email, getClientAllowedEmails());
}

export async function signInWithGooglePopup(): Promise<User> {
  const credential = await signInWithPopup(auth, googleProvider);
  return credential.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export async function getAuthIdToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user || !isAuthorizedUser(user)) {
    throw new Error('Authentication required. Please sign in with an authorized Google account.');
  }
  return user.getIdToken();
}
