import crypto from 'node:crypto';
import firebaseAppletConfig from '../firebase-applet-config.json' with { type: 'json' };
import {
  ACCESS_DENIED_MESSAGE,
  isEmailAuthorized,
  parseAllowedEmails,
} from './authConfig.ts';

const FIREBASE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

interface CertCache {
  certs: Record<string, string>;
  expiresAt: number;
}

let certCache: CertCache | null = null;

interface FirebaseJwtHeader {
  alg?: string;
  kid?: string;
}

interface FirebaseJwtPayload {
  aud?: string;
  iss?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  auth_time?: number;
  email?: string;
  email_verified?: boolean;
}

export interface VerifiedFirebaseUser {
  uid: string;
  email: string;
}

function getFirebaseProjectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.VITE_FIREBASE_PROJECT_ID ||
    firebaseAppletConfig.projectId ||
    ''
  ).trim();
}

function getAllowedEmails(): string[] {
  return parseAllowedEmails(process.env.ALLOWED_EMAIL || process.env.VITE_ALLOWED_EMAIL);
}

function decodeBase64UrlJson<T>(segment: string): T {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(padded, 'base64').toString('utf8');
  return JSON.parse(json) as T;
}

async function fetchPublicCerts(forceRefresh = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!forceRefresh && certCache && now < certCache.expiresAt) {
    return certCache.certs;
  }

  const response = await fetch(FIREBASE_CERTS_URL);
  if (!response.ok) {
    throw Object.assign(
      new Error('Could not verify authentication signature with Google identity servers.'),
      { statusCode: 503 },
    );
  }

  const certs = (await response.json()) as Record<string, string>;
  const cacheControl = response.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSec = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;

  certCache = {
    certs,
    expiresAt: now + Math.max(60, maxAgeSec) * 1000,
  };

  return certs;
}

export async function verifyAuthorizedRequest(
  authorizationHeader: string | null | undefined,
): Promise<VerifiedFirebaseUser> {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    throw Object.assign(
      new Error('Authentication required. Please sign in with an authorized Google account.'),
      { statusCode: 401 },
    );
  }

  const token = authorizationHeader.slice('Bearer '.length).trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('Invalid authentication token.'), { statusCode: 401 });
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: FirebaseJwtHeader;
  let payload: FirebaseJwtPayload;
  try {
    header = decodeBase64UrlJson<FirebaseJwtHeader>(headerB64);
    payload = decodeBase64UrlJson<FirebaseJwtPayload>(payloadB64);
  } catch {
    throw Object.assign(new Error('Malformed authentication token.'), { statusCode: 401 });
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw Object.assign(new Error('Unsupported authentication token signature.'), {
      statusCode: 401,
    });
  }

  let certs = await fetchPublicCerts(false);
  let certPem = certs[header.kid];
  if (!certPem) {
    certs = await fetchPublicCerts(true);
    certPem = certs[header.kid];
  }

  if (!certPem) {
    throw Object.assign(new Error('Authentication token signing key could not be verified.'), {
      statusCode: 401,
    });
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(
    signatureB64.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();

  const isSignatureValid = verifier.verify(certPem, signature);
  if (!isSignatureValid) {
    throw Object.assign(new Error('Invalid authentication token signature.'), {
      statusCode: 401,
    });
  }

  const projectId = getFirebaseProjectId();
  if (!projectId) {
    throw Object.assign(
      new Error('Firebase project ID is not configured on the server.'),
      { statusCode: 500 },
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;

  if (payload.aud !== projectId || payload.iss !== expectedIssuer) {
    throw Object.assign(new Error('Authentication token project mismatch.'), { statusCode: 401 });
  }

  if (!payload.sub || typeof payload.sub !== 'string') {
    throw Object.assign(new Error('Invalid authentication subject.'), { statusCode: 401 });
  }

  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw Object.assign(new Error('Your session has expired. Please sign in again.'), {
      statusCode: 401,
    });
  }

  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
    throw Object.assign(new Error('Invalid authentication timestamp.'), { statusCode: 401 });
  }

  if (!payload.email || payload.email_verified !== true) {
    throw Object.assign(new Error(ACCESS_DENIED_MESSAGE), { statusCode: 403 });
  }

  const allowedEmails = getAllowedEmails();
  if (!isEmailAuthorized(payload.email, allowedEmails)) {
    throw Object.assign(new Error(ACCESS_DENIED_MESSAGE), { statusCode: 403 });
  }

  return {
    uid: payload.sub,
    email: payload.email,
  };
}
