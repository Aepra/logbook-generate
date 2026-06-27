import { GoogleAuth } from 'google-auth-library';

let auth: GoogleAuth | null = null;

/**
 * Initializes and returns the Google Service Account access token.
 * This function caches the Auth instance and handles token refreshes automatically
 * via the google-auth-library.
 */
export async function getServiceAccountToken(): Promise<string | null> {
  try {
    if (!auth) {
      // In production/Vercel, we might pass credentials via JSON string or individual vars.
      // Easiest is to set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY
      const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      let privateKey = process.env.GOOGLE_PRIVATE_KEY;

      if (!clientEmail || !privateKey) {
        console.error("[Google Service Account] Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY in .env");
        return null;
      }

      // Handle cases where private key is stringified with \n
      if (privateKey.includes("\\n")) {
        privateKey = privateKey.replace(/\\n/g, "\n");
      }

      auth = new GoogleAuth({
        credentials: {
          client_email: clientEmail,
          private_key: privateKey,
        },
        scopes: [
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/documents',
        ],
      });
    }

    const client = await auth.getClient();
    const token = await client.getAccessToken();

    if (!token.token) {
      console.error("[Google Service Account] Failed to retrieve token string");
      return null;
    }

    return token.token;
  } catch (error) {
    console.error("[Google Service Account] Error generating token:", error);
    return null;
  }
}
