/**
 * Google Drive Service — v2
 * ==========================
 * Pure storage layer. Only file responsible for Google Drive API calls.
 *
 * v2 changes:
 *   - Folder key: logbookId (NOT logbook title) — immutable, unique, no sanitization
 *   - Retry with exponential backoff for all Drive API calls (2 retries: 500ms, 1000ms)
 *   - Token refresh on 401 responses (retry ONCE with new token)
 *   - Pluggable cache (MapCache dev, Redis production)
 *   - Structured error via DriveError
 *   - TraceId logging throughout
 *   - File name sanitization
 *   - Max upload size enforcement
 *   - Auto-repair stale root folder via userEmail
 */

import type { TraceContext, DriveError, UploadFileParams, UploadFileResult } from "@/types/drive";
import { ICache, CACHE_PREFIX } from "@/services/cache/ICache";
import { getServiceAccountToken } from "@/lib/google-service-account";
import { defaultCache } from "@/services/cache/MapCache";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const ROOT_FOLDER_NAME = "LogBook.ID";
const IMAGE_ROOT_NAME = "logbookidImage";
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

// ─────────────────────────────────────
//  CACHE — SAFETY FLAG + DOC
// ─────────────────────────────────────
/**
 * Cache strategy notes (v2):
 * - MapCache is process-scoped, NOT shared across serverless instances.
 * - In single-instance (dev / docker), cache reduces Drive API calls.
 * - In multi-instance / serverless (Vercel, Render), cache starts empty
 *   on every cold start — effectively a no-op. This is SAFE but provides
 *   zero performance benefit.
 * - All cached values are treated as "hints" — the code MUST always
 *   revalidate on cache miss and handle stale/missing results gracefully.
 * - Cache keys expire on process restart only; no TTL invalidation exists.
 * - For production multi-instance: swap MapCache with RedisCache (not yet implemented).
 */
let sharedCache: ICache = defaultCache;

export function setDriveCache(cache: ICache): void { sharedCache = cache; }
export function getDriveCache(): ICache { return sharedCache; }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────
//  SANITIZATION
// ─────────────────────────────────────
function sanitizeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().substring(0, 200);
}
function sanitizeFolderName(name: string): string {
  return sanitizeFileName(name).toLowerCase();
}

// ─────────────────────────────────────
//  CORE FETCH WRAPPER (retry + token refresh)
// ─────────────────────────────────────
async function driveFetch(
  trace: TraceContext,
  step: string,
  action: string,
  url: string,
  options: {
    method: string;
    headers: Record<string, string>;
    body?: BodyInit;
  }
): Promise<{ ok: boolean; status: number; data: unknown }> {
  let currentToken = await getServiceAccountToken();
  if (!currentToken) return { ok: false, status: 401, data: { code: "TOKEN_MISSING" } };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const start = performance.now();
    let response: Response;

    try {
      response = await fetch(url, {
        method: options.method,
        headers: { ...options.headers, Authorization: `Bearer ${currentToken}` },
        body: options.body,
      });
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      trace.warn(step, `fetch error attempt ${attempt + 1}: ${err instanceof Error ? err.message : String(err)}`, { elapsed });
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        trace.log(step, `retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      return { ok: false, status: 0, data: { code: "NETWORK_ERROR", message: String(err) } };
    }

    const elapsed = Math.round(performance.now() - start);
    trace.log(step, `${action} → ${response.status} (${elapsed}ms)`, { attempt: attempt + 1 });

    if (response.ok) {
      let data: unknown = null;
      try { data = await response.json(); } catch { /* empty */ }
      return { ok: true, status: response.status, data };
    }

    // 401 → token refresh ONCE (not counted as retry)
    if (response.status === 401 && attempt === 0) {
      trace.warn(step, "Drive returned 401 — attempting token refresh...");
      const newToken = await getServiceAccountToken();
      if (newToken) {
        trace.log(step, "token refreshed, retrying with new token...");
        currentToken = newToken;
        continue; // retry (not counted as retry)
      }
      trace.error(step, "token refresh failed");
      let body: Record<string, unknown> = {};
      try { body = await response.json(); } catch { /* empty */ }
      return { ok: false, status: 401, data: { code: "TOKEN_REFRESH_FAILED", ...body } };
    }

    // 429 / 5xx → retry
    if (response.status === 429 || response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        trace.warn(step, `${action} → ${response.status}, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      trace.error(step, `${action} → ${response.status} after all retries`);
    }

    // Other 4xx → no retry
    let errorData: Record<string, unknown> = {};
    try { errorData = await response.json(); } catch { /* empty */ }
    return { ok: false, status: response.status, data: errorData };
  }

  return { ok: false, status: 0, data: { code: "MAX_RETRIES_EXCEEDED" } };
}

// ─────────────────────────────────────
//  FOLDER OPERATIONS
// ─────────────────────────────────────
async function createDriveFolder(
  trace: TraceContext,
  name: string,
  parentId?: string
): Promise<string | null> {
  const body: Record<string, unknown> = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) body.parents = [parentId];

  const result = await driveFetch(trace, "CREATE_FOLDER", "createFolder", `${DRIVE_API_BASE}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!result.ok) {
    trace.error("CREATE_FOLDER", "failed", { name, parentId, status: result.status });
    return null;
  }
  const data = result.data as { id?: string } | null;
  if (!data?.id) {
    trace.error("CREATE_FOLDER", "no id in response", { name });
    return null;
  }
  trace.log("CREATE_FOLDER", "success", { id: data.id, name });
  return data.id;
}

async function findDriveFolder(
  trace: TraceContext,
  name: string,
  parentId?: string
): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,parents,name)&pageSize=1`;
  const result = await driveFetch(trace, "FIND_FOLDER", "findFolder", url, {
    method: "GET", headers: {},
  });

  if (!result.ok) {
    trace.error("FIND_FOLDER", "failed", { name, parentId, status: result.status });
    return null;
  }
  const data = result.data as { files?: Array<{ id: string; name: string }> } | null;
  if (data?.files?.length) {
    trace.log("FIND_FOLDER", "found", { id: data.files[0].id, name });
    return data.files[0].id;
  }
  trace.log("FIND_FOLDER", "not found", { name, parentId });
  return null;
}

/**
 * Searches for a Drive folder by name only (no parent constraint).
 * Used for repair when the stored root folder ID is stale.
 */
async function findDriveFolderGlobal(
  trace: TraceContext,
  name: string
): Promise<string | null> {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,parents)&pageSize=10`;
  const result = await driveFetch(trace, "FIND_FOLDER_GLOBAL", "findFolderGlobal", url, {
    method: "GET", headers: {},
  });
  if (!result.ok) return null;
  const data = result.data as { files?: Array<{ id: string; name: string; parents?: string[] }> } | null;
  if (data?.files?.length) {
    trace.log("FIND_FOLDER_GLOBAL", "found", { id: data.files[0].id, name });
    return data.files[0].id;
  }
  trace.log("FIND_FOLDER_GLOBAL", "not found", { name });
  return null;
}

// ─────────────────────────────────────
//  VERIFICATION — EXPORTED
// ─────────────────────────────────────
export async function getDriveFileMeta(
  trace: TraceContext, fileId: string
): Promise<{ id: string; name: string; parents: string[]; webViewLink: string; mimeType: string } | null> {
  const url = `${DRIVE_API_BASE}/files/${fileId}?fields=id,name,parents,webViewLink,mimeType`;
  const result = await driveFetch(trace, "FILE_META", "getFileMeta", url, {
    method: "GET", headers: {},
  });
  if (!result.ok) return null;
  return result.data as { id: string; name: string; parents: string[]; webViewLink: string; mimeType: string } | null;
}

export async function verifyDriveFolderId(
  trace: TraceContext, folderId: string
): Promise<{ id: string; name: string; parents: string[] } | null> {
  const url = `${DRIVE_API_BASE}/files/${folderId}?fields=id,name,mimeType,parents`;
  const result = await driveFetch(trace, "VERIFY_FOLDER", "verifyFolder", url, {
    method: "GET", headers: {},
  });
  if (!result.ok) return null;
  const data = result.data as { id: string; name: string; mimeType: string; parents: string[] } | null;
  if (!data || data.mimeType !== "application/vnd.google-apps.folder") {
    trace.error("VERIFY_FOLDER", "not a folder", { folderId });
    return null;
  }
  return data;
}

export async function listDriveFolderContents(
  trace: TraceContext, folderId: string, pageSize = 100
): Promise<Array<{ id: string; name: string; mimeType: string; parents: string[] }>> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const url = `${DRIVE_API_BASE}/files?q=${q}&fields=files(id,name,mimeType,parents,webViewLink)&pageSize=${pageSize}&orderBy=name`;
  const result = await driveFetch(trace, "LIST_FOLDER", "listFolder", url, {
    method: "GET", headers: {},
  });
  if (!result.ok) return [];
  const data = result.data as { files?: Array<{ id: string; name: string; mimeType: string; parents: string[] }> } | null;
  return data?.files || [];
}

export async function verifyAndRepairUserRootFolder(
  trace: TraceContext,
  storedFolderId: string | null, userEmail: string
): Promise<{ valid: boolean; folderId: string | null; repairNeeded: boolean; message: string }> {
  trace.log("VERIFY_ROOT", "checking root folder", { email: userEmail, storedId: storedFolderId });

  if (storedFolderId) {
    const v = await verifyDriveFolderId(trace, storedFolderId);
    if (v) return { valid: true, folderId: storedFolderId, repairNeeded: false, message: "Folder ID valid" };
    trace.warn("VERIFY_ROOT", "stored id invalid, attempting repair...");
  }

  let rootId = await findDriveFolder(trace, ROOT_FOLDER_NAME);
  if (!rootId) rootId = await createDriveFolder(trace, ROOT_FOLDER_NAME);
  if (!rootId) return { valid: false, folderId: null, repairNeeded: true, message: "Tidak bisa membuat root folder" };

  let userId = await findDriveFolder(trace, userEmail, rootId);
  if (!userId) userId = await createDriveFolder(trace, userEmail, rootId);

  if (!userId) return { valid: false, folderId: null, repairNeeded: true, message: "Tidak bisa membuat user folder" };
  trace.log("VERIFY_ROOT", "repair success", { newId: userId });
  return { valid: true, folderId: userId, repairNeeded: true, message: "Folder ID diperbaiki" };
}

/**
 * Deletes a file from Google Drive by its fileId.
 * Used for best-effort orphan cleanup when DB insert fails.
 * Never throws — logs and returns false on failure.
 */
export async function deleteDriveFile(
  trace: TraceContext,
  fileId: string
): Promise<boolean> {
  trace.log("DELETE_FILE", "attempting cleanup", { fileId });
  try {
    const result = await driveFetch(trace, "DELETE_FILE", "deleteFile", `${DRIVE_API_BASE}/files/${fileId}`, {
      method: "DELETE",
      headers: {},
    });
    if (result.ok) {
      trace.log("DELETE_FILE", "cleanup success", { fileId });
      return true;
    }
    trace.warn("DELETE_FILE", "cleanup failed", { status: result.status, fileId });
    return false;
  } catch (err) {
    trace.warn("DELETE_FILE", "cleanup threw", { error: err instanceof Error ? err.message : String(err), fileId });
    return false;
  }
}

export async function buildFolderPathChain(
  trace: TraceContext, folderId: string
): Promise<string[]> {
  const path: string[] = [];
  let currentId: string | null = folderId;
  while (currentId) {
    const url = `${DRIVE_API_BASE}/files/${currentId}?fields=id,name,parents`;
    const result = await driveFetch(trace, "PATH_CHAIN", "buildPath", url, {
      method: "GET", headers: {},
    });
    if (!result.ok) break;
    const data = result.data as { id: string; name: string; parents?: string[] } | null;
    if (!data) break;
    path.unshift(`${data.name} (${data.id})`);
    currentId = data.parents?.[0] || null;
  }
  return path;
}

// ─────────────────────────────────────
//  USER ROOT FOLDER — EXPORTED
// ─────────────────────────────────────
export async function getOrCreateUserRootFolder(
  trace: TraceContext, userEmail: string
): Promise<string | null> {
  let rootId = await findDriveFolder(trace, ROOT_FOLDER_NAME);
  if (!rootId) rootId = await createDriveFolder(trace, ROOT_FOLDER_NAME);
  if (!rootId) return null;
  let userId = await findDriveFolder(trace, userEmail, rootId);
  if (!userId) userId = await createDriveFolder(trace, userEmail, rootId);
  return userId;
}

export async function createLogbookFolder(
  trace: TraceContext,
  userRootFolderId: string, logbookTitle: string
): Promise<string | null> {
  return createDriveFolder(trace, sanitizeFileName(logbookTitle), userRootFolderId);
}

// ─────────────────────────────────────
//  REPAIR stale root folder
// ─────────────────────────────────────
/**
 * Recreates the LogBook.ID/{email} folder chain in Drive.
 * Returns the new user root folder ID.
 */
async function repairRootFolder(
  trace: TraceContext,
  userEmail: string
): Promise<string | null> {
  trace.log("REPAIR_ROOT", "recreating LogBook.ID/{email} folder chain", { email: userEmail });

  let rootId = await findDriveFolder(trace, ROOT_FOLDER_NAME);
  if (!rootId) rootId = await createDriveFolder(trace, ROOT_FOLDER_NAME);
  if (!rootId) {
    trace.error("REPAIR_ROOT", "cannot create LogBook.ID root folder");
    return null;
  }

  let userId = await findDriveFolder(trace, userEmail, rootId);
  if (!userId) userId = await createDriveFolder(trace, userEmail, rootId);
  if (!userId) {
    trace.error("REPAIR_ROOT", "cannot create user folder");
    return null;
  }

  trace.log("REPAIR_ROOT", "success", { newRootId: userId });
  return userId;
}

// ─────────────────────────────────────
//  PHOTO FOLDER — v2 (logbookId based)
// ─────────────────────────────────────
/**
 * Resolves the photo folder chain:
 *   LogBook.ID/{email}/logbookidImage/{logbookId}/
 *
 * When the stored root ID (userRootFolderId) is stale:
 *   1. Global search for logbookidImage (no parent constraint)
 *   2. If not found, recreate LogBook.ID/{email} via repairRootFolder()
 *   3. Create logbookidImage under repaired root
 *   4. Create {logbookId} under logbookidImage
 */
async function resolvePhotoFolder(
  trace: TraceContext,
  userRootFolderId: string, logbookId: string, userEmail: string
): Promise<{ folderId: string | null; error?: DriveError; newRootId?: string }> {
  const verifyKey = CACHE_PREFIX.VERIFIED_ROOT + userRootFolderId;
  let rootIsStale = false;

  if (sharedCache.get(verifyKey) !== "verified") {
    trace.log("RESOLVE_PHOTO_FOLDER", "verifying user root folder");
    const v = await verifyDriveFolderId(trace, userRootFolderId);
    if (!v) {
      trace.warn("RESOLVE_PHOTO_FOLDER", "stored root id returned 404 — stale or deleted");
      sharedCache.set(verifyKey, null);
      rootIsStale = true;
      trace.log("RESOLVE_PHOTO_FOLDER", "root verification failed — will attempt repair");
    } else {
      sharedCache.set(verifyKey, "verified");
    }
  }

  // ── Step 1: find/create logbookidImage folder ──
  const imageKey = CACHE_PREFIX.IMAGE_ROOT + userRootFolderId;
  let imageId = sharedCache.get(imageKey);

  if (imageId === undefined || imageId === null) {
    // Try parent-constrained search first (fast path)
    imageId = await findDriveFolder(trace, IMAGE_ROOT_NAME, userRootFolderId);

    // === CACHE DEADLOCK FIX ===
    // If root is cached as "verified" but downstream operations fail,
    // the cache is stale. Re-verify root and force revalidation.
    if (!imageId && !rootIsStale && sharedCache.get(verifyKey) === "verified") {
      trace.warn("RESOLVE_PHOTO_FOLDER", "imageRoot not found under cached-valid root — cache may be stale. Forcing revalidation...");
      sharedCache.del(verifyKey);
      const v = await verifyDriveFolderId(trace, userRootFolderId);
      if (!v) {
        trace.warn("RESOLVE_PHOTO_FOLDER", "revalidation confirmed: root is stale. Deleting imageRoot cache...");
        rootIsStale = true;
        sharedCache.del(imageKey); // also invalidate image root cache
      } else {
        trace.log("RESOLVE_PHOTO_FOLDER", "revalidation: root is still valid, imageRoot truly doesn't exist");
        sharedCache.set(verifyKey, "verified"); // restore cache
      }
    }

    // Optimization: only attempt global search if root is stale
    // When root is valid and parent-constrained search failed, the folder
    // genuinely doesn't exist under this root — just create it.
    if (!imageId && rootIsStale) {
      trace.log("RESOLVE_PHOTO_FOLDER", "logbookidImage not found under parent (stale root), trying global search...");
      imageId = await findDriveFolderGlobal(trace, IMAGE_ROOT_NAME);
    }

    if (!imageId && rootIsStale) {
      // Root is stale and logbookidImage doesn't exist anywhere — repair the chain
      trace.log("RESOLVE_PHOTO_FOLDER", "repairing root folder via userEmail...");
      const newRootId = await repairRootFolder(trace, userEmail);
      if (newRootId) {
        trace.log("RESOLVE_PHOTO_FOLDER", "root repaired, creating logbookidImage under new root", { newRootId });
        imageId = await createDriveFolder(trace, IMAGE_ROOT_NAME, newRootId);
        if (imageId) {
          // Update cache with new root ID
          sharedCache.set(verifyKey, "verified");
          return resolvePhotoFolder(trace, newRootId, logbookId, userEmail);
        }
      }
    }

    if (!imageId) {
      // Last attempt: create under stored root (even if stale, might work)
      trace.log("RESOLVE_PHOTO_FOLDER", "creating logbookidImage under stored root...");
      imageId = await createDriveFolder(trace, IMAGE_ROOT_NAME, userRootFolderId);
    }

    if (!imageId) {
      trace.error("RESOLVE_PHOTO_FOLDER", "cannot find or create logbookidImage");
      sharedCache.set(imageKey, null);
      return {
        folderId: null,
        error: {
          code: "FOLDER_NOT_FOUND",
          message: "Folder foto root tidak ditemukan dan tidak bisa diperbaiki. Silakan login ulang.",
          step: "RESOLVE_IMAGE_ROOT",
          retryable: false,
        },
      };
    }

    sharedCache.set(imageKey, imageId);
    trace.log("RESOLVE_PHOTO_FOLDER", "logbookidImage resolved", { imageId });
  }

  // ── Step 2: find/create logbook-specific folder ──
  const logbookKey = CACHE_PREFIX.LOGBOOK_FOLDER + userRootFolderId + ":" + logbookId;
  const cached = sharedCache.get(logbookKey);
  if (cached !== undefined && cached !== null) {
    trace.log("RESOLVE_PHOTO_FOLDER", "cache hit for logbook folder", { logbookId, folderId: cached });
    return { folderId: cached };
  }

  const safe = sanitizeFolderName(logbookId);
  let folderId = await findDriveFolder(trace, safe, imageId);

  if (!folderId) {
    trace.log("RESOLVE_PHOTO_FOLDER", "not found under image root, trying global search...");
    folderId = await findDriveFolderGlobal(trace, safe);
  }

  if (!folderId) {
    trace.log("RESOLVE_PHOTO_FOLDER", "creating logbook folder", { safe });
    folderId = await createDriveFolder(trace, safe, imageId);
  }

  if (folderId) {
    sharedCache.set(logbookKey, folderId);
    return { folderId };
  }

  sharedCache.set(logbookKey, null);
  return {
    folderId: null,
    error: {
      code: "FOLDER_CREATE_FAILED",
      message: "Gagal membuat folder logbook di Google Drive.",
      step: "CREATE_LOGBOOK_FOLDER",
      retryable: true,
    },
  };
}

// ─────────────────────────────────────
//  MAIN UPLOAD — v2
// ─────────────────────────────────────
export async function uploadFileToActivityFolder(params: UploadFileParams): Promise<UploadFileResult | null> {
  const { trace, fileBuffer, fileName, mimeType, userRootFolderId, logbookId, userEmail } = params;

  trace.log("UPLOAD_START", "begin upload", { fileName, mimeType, size: fileBuffer.byteLength, logbookId });

  if (fileBuffer.byteLength > MAX_FILE_SIZE) {
    trace.error("VALIDATE", "file exceeds max size", { size: fileBuffer.byteLength, max: MAX_FILE_SIZE });
    return null;
  }

  const safeName = sanitizeFileName(fileName);
  if (!safeName) {
    trace.error("VALIDATE", "invalid file name after sanitization", { original: fileName });
    return null;
  }

  const folderResult = await resolvePhotoFolder(trace, userRootFolderId, logbookId, userEmail);
  if (!folderResult.folderId) {
    trace.error("RESOLVE", "failed to resolve folder", { logbookId });
    return null;
  }

  // Build multipart body
  const boundary = "drive_upload_boundary_" + Date.now();
  const metadata = JSON.stringify({ name: safeName, parents: [folderResult.folderId] });
  const encoder = new TextEncoder();
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
  const metaBytes = encoder.encode(metaPart);
  const mediaHeadBytes = encoder.encode(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const mediaFootBytes = encoder.encode(`\r\n--${boundary}--`);

  const totalLen = metaBytes.length + mediaHeadBytes.length + fileBuffer.byteLength + mediaFootBytes.length;
  const body = new Uint8Array(totalLen);
  let off = 0;
  body.set(metaBytes, off); off += metaBytes.length;
  body.set(mediaHeadBytes, off); off += mediaHeadBytes.length;
  body.set(new Uint8Array(fileBuffer), off); off += fileBuffer.byteLength;
  body.set(mediaFootBytes, off);

  trace.log("MULTIPART", "body assembled", { totalBytes: totalLen });

  // Upload with retry + token refresh
  let currentToken = await getServiceAccountToken();
  if (!currentToken) return null;
  let uploadOk = false;
  let responseData: Record<string, unknown> = {};

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const start = performance.now();
    let response: Response;

    try {
      response = await fetch(
        `${UPLOAD_BASE}/files?uploadType=multipart&fields=id,webViewLink,name,mimeType,parents`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${currentToken}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
            "Content-Length": totalLen.toString(),
          },
          body,
        }
      );
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      trace.warn("UPLOAD", `fetch error attempt ${attempt + 1}: ${err instanceof Error ? err.message : String(err)}`, { elapsed });
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        trace.log("UPLOAD", `retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      trace.error("UPLOAD", "network error after all retries");
      return null;
    }

    const elapsed = Math.round(performance.now() - start);
    trace.log("UPLOAD", `Drive → ${response.status} (${elapsed}ms)`, { attempt: attempt + 1 });

    if (response.ok) {
      responseData = await response.json().catch(() => ({}));
      uploadOk = true;
      break;
    }

    // 401 → refresh token once
    if (response.status === 401 && attempt === 0) {
      trace.warn("UPLOAD", "Drive returned 401 — refreshing token...");
      const newToken = await getServiceAccountToken();
      if (newToken) {
        trace.log("UPLOAD", "token refreshed, retrying...");
        currentToken = newToken;
        continue; // not counted as retry
      }
      trace.error("UPLOAD", "token refresh failed");
      return null;
    }

    // 429 / 5xx → retry
    if (response.status === 429 || response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        trace.warn("UPLOAD", `Drive ${response.status}, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      trace.error("UPLOAD", `Drive ${response.status} after all retries`);
      return null;
    }

    // 4xx non-retryable
    let err: Record<string, unknown> = {};
    try { err = await response.json(); } catch { /* empty */ }
    trace.error("UPLOAD", `non-retryable ${response.status}`, err);
    return null;
  }

  if (!uploadOk) {
    trace.error("UPLOAD", "failed after all attempts");
    return null;
  }

  const fileId = responseData.id as string | undefined;
  if (!fileId) {
    trace.error("UPLOAD", "no fileId in response");
    return null;
  }

  const webViewLink = responseData.webViewLink as string | undefined;

  // ── Make file publicly viewable ──
  // Without this, the thumbnail/image URL returns a placeholder.
  trace.log("UPLOAD_PERMISSIONS", "granting public read access...", { fileId });
  try {
    const permResult = await fetch(`${DRIVE_API_BASE}/files/${fileId}/permissions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
    if (permResult.ok) {
      trace.log("UPLOAD_PERMISSIONS", "public read access granted");
    } else {
      const permErr = await permResult.json().catch(() => ({}));
      trace.warn("UPLOAD_PERMISSIONS", `failed to grant public access: ${permResult.status}`, permErr);
    }
  } catch (permErr) {
    trace.warn("UPLOAD_PERMISSIONS", "grant public access threw", { error: String(permErr) });
  }

  trace.log("UPLOAD_DONE", "complete", { fileId, webViewLink: webViewLink || "unknown" });
  return { fileId, webViewLink: webViewLink || "" };
}

/**
 * Uploads a DOCX buffer to Google Drive as a temporary Google Doc,
 * exports it as a PDF buffer, and deletes the temporary file.
 */
export async function convertDocxToPdf(
  trace: TraceContext,
  docxBuffer: Buffer
): Promise<Buffer | null> {
  trace.log("CONVERT_PDF_START", "Uploading temporary DOCX to Drive...");

  const boundary = "docx_pdf_conversion_boundary_" + Date.now();
  const metadata = JSON.stringify({
    name: `temp_logbook_conversion_${Date.now()}`,
    mimeType: "application/vnd.google-apps.document",
  });
  
  const encoder = new TextEncoder();
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
  const metaBytes = encoder.encode(metaPart);
  const mediaHeadBytes = encoder.encode(`--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`);
  const mediaFootBytes = encoder.encode(`\r\n--${boundary}--`);

  const totalLen = metaBytes.length + mediaHeadBytes.length + docxBuffer.byteLength + mediaFootBytes.length;
  const body = new Uint8Array(totalLen);
  let off = 0;
  body.set(metaBytes, off); off += metaBytes.length;
  body.set(mediaHeadBytes, off); off += mediaHeadBytes.length;
  body.set(new Uint8Array(docxBuffer), off); off += docxBuffer.byteLength;
  body.set(mediaFootBytes, off);

  const uploadResult = await driveFetch(trace, "CONVERT_PDF_UPLOAD", "uploadTempDocx", `${UPLOAD_BASE}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": totalLen.toString(),
    },
    body,
  });

  if (!uploadResult.ok) {
    trace.error("CONVERT_PDF_UPLOAD", "failed to upload temp DOCX", { status: uploadResult.status, data: uploadResult.data });
    return null;
  }

  const uploadData = uploadResult.data as { id?: string } | null;
  const fileId = uploadData?.id;
  if (!fileId) {
    trace.error("CONVERT_PDF_UPLOAD", "no file ID in response");
    return null;
  }

  trace.log("CONVERT_PDF_EXPORT", "Exporting Google Doc as PDF...", { fileId });

  const exportUrl = `${DRIVE_API_BASE}/files/${fileId}/export?mimeType=application/pdf`;
  
  let currentToken = await getServiceAccountToken();
  if (!currentToken) return null;
  let pdfBuffer: Buffer | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(exportUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${currentToken}` },
      });

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        pdfBuffer = Buffer.from(arrayBuffer);
        break;
      }

      if (response.status === 401 && attempt === 0) {
        trace.warn("CONVERT_PDF_EXPORT", "401 during export, refreshing token...");
        const newToken = await getServiceAccountToken();
        if (newToken) {
          currentToken = newToken;
          continue;
        }
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
      }

      const errMsg = await response.text();
      trace.error("CONVERT_PDF_EXPORT", `Export failed with status ${response.status}: ${errMsg}`);
      break;
    } catch (err) {
      trace.error("CONVERT_PDF_EXPORT", `Export fetch error: ${String(err)}`);
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  trace.log("CONVERT_PDF_CLEANUP", "Deleting temporary Google Doc...", { fileId });
  await deleteDriveFile(trace, fileId);

  return pdfBuffer;
}

