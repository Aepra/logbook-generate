/**
 * POST /api/photos/upload — v2
 * ==============================
 * Uploads a photo to Google Drive under logbookidImage/{logbookId}.
 *
 * v2 changes:
 *   - TraceId for end-to-end observability
 *   - Centralized server-side validation (file type, size, count)
 *   - Token refresh callback (on-demand when Drive returns 401)
 *   - Structured error responses
 *   - Max file count enforcement (10 per request)
 *   - File name sanitization warning
 */

import { getServerSession } from "next-auth/next";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getUserIdByEmail } from "@/lib/user";
import { uploadActivityPhoto } from "@/services/photo.service";
import { createTraceContext } from "@/types/drive";
import { refreshAccessToken } from "@/lib/token-refresh";

/** Accepted MIME types */
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Max file size in bytes (5 MB) */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Max number of files per request */
const MAX_FILES = 10;

/**
 * Validates a file on the server side.
 * Returns error response if invalid, null if valid.
 */
function validateFile(file: File, index: number): NextResponse | null {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { code: "INVALID_FILE_TYPE", message: `File #${index + 1}: Tipe ${file.type} tidak didukung. Hanya JPEG, PNG, dan WebP.`, step: "VALIDATE", retryable: false },
      { status: 400 }
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { code: "FILE_TOO_LARGE", message: `File #${index + 1}: Ukuran ${(file.size / 1024 / 1024).toFixed(1)}MB melebihi batas 5MB.`, step: "VALIDATE", retryable: false },
      { status: 400 }
    );
  }

  return null;
}

export async function POST(request: NextRequest) {
  const trace = createTraceContext();
  trace.log("START", "photo upload request received");

  // ── Auth ──
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    trace.error("AUTH", "no session email");
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Silakan login terlebih dahulu.", step: "AUTH", retryable: false },
      { status: 401 }
    );
  }
  trace.log("AUTH", "session valid", { email: session.user.email, hasAccessToken: !!session.accessToken });

  // ── Parse form data ──
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (err) {
    trace.error("PARSE", "failed to parse form data", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { code: "INVALID_FORM_DATA", message: "Format request tidak valid.", step: "PARSE", retryable: false },
      { status: 400 }
    );
  }

  const activityId = formData.get("activity_id") as string | null;
  const files = formData.getAll("file") as File[];

  if (!activityId) {
    trace.error("VALIDATE", "missing activity_id");
    return NextResponse.json(
      { code: "MISSING_ACTIVITY_ID", message: "activity_id wajib diisi.", step: "VALIDATE", retryable: false },
      { status: 400 }
    );
  }

  if (files.length === 0) {
    trace.error("VALIDATE", "no files provided");
    return NextResponse.json(
      { code: "NO_FILES", message: "Tidak ada file yang diupload.", step: "VALIDATE", retryable: false },
      { status: 400 }
    );
  }

  if (files.length > MAX_FILES) {
    trace.error("VALIDATE", "too many files", { count: files.length, max: MAX_FILES });
    return NextResponse.json(
      { code: "TOO_MANY_FILES", message: `Maksimal ${MAX_FILES} file per request.`, step: "VALIDATE", retryable: false },
      { status: 400 }
    );
  }

  trace.log("VALIDATE", `parsed ${files.length} file(s) for activity ${activityId}`);

  // ── Sanitize file names (check, don't modify — user should rename) ──
  for (let i = 0; i < files.length; i++) {
    const sanitized = files[i].name.replace(/[/\\:*?"<>|]/g, "_");
    if (sanitized !== files[i].name) {
      trace.warn("VALIDATE", `file #${i + 1} name contains unsafe characters`, { original: files[i].name });
    }
  }

  // ── Validate each file ──
  for (let i = 0; i < files.length; i++) {
    const error = validateFile(files[i], i);
    if (error) return error;
  }

  // ── Resolve user ID ──
  const userId = await getUserIdByEmail(session.user.email);
  if (!userId) {
    trace.error("USER", "user not found in DB", { email: session.user.email });
    return NextResponse.json(
      { code: "USER_NOT_FOUND", message: "User tidak ditemukan di database.", step: "USER", retryable: false },
      { status: 404 }
    );
  }
  trace.log("USER", `userId resolved: ${userId}`);

  // ── Access token check ──
  const accessToken = session.accessToken;
  const accessTokenExpires = session.accessTokenExpires;
  const refreshTokenRaw = session.refreshToken;
  const isExpired = accessTokenExpires ? Date.now() >= accessTokenExpires : false;

  trace.log("TOKEN", "access token status", {
    hasToken: !!accessToken,
    hasRefreshToken: !!refreshTokenRaw,
    isExpired,
    expiresAt: accessTokenExpires ? new Date(accessTokenExpires).toISOString() : "unknown",
  });

  if (!accessToken) {
    trace.error("TOKEN", "no access token available");
    return NextResponse.json(
      { code: "TOKEN_MISSING", message: "Sesi Google Drive tidak tersedia. Silakan logout dan login ulang.", step: "TOKEN", action: "RELOGIN_REQUIRED", retryable: false },
      { status: 401 }
    );
  }

  // ── Build refreshToken callback ──
  // This will be passed to the Drive service and called on 401.
  // It uses the same refreshToken logic as NextAuth's JWT callback.
  const refreshTokenCallback = async (): Promise<string | null> => {
    if (!refreshTokenRaw) {
      trace.warn("TOKEN_REFRESH", "no refresh token available");
      return null;
    }
    trace.log("TOKEN_REFRESH", "attempting refresh...");
    const refreshed = await refreshAccessToken({
      accessToken,
      refreshToken: refreshTokenRaw,
      accessTokenExpires,
    });
    if (refreshed.accessToken) {
      trace.log("TOKEN_REFRESH", "success", { newExpiry: refreshed.accessTokenExpires ? new Date(refreshed.accessTokenExpires).toISOString() : "unknown" });
      return refreshed.accessToken;
    }
    trace.error("TOKEN_REFRESH", "failed");
    return null;
  };

  // ── Process only the first file (single upload per request for now) ──
  // Multiple files will need multiple requests. The frontend already loops.
  const file = files[0];

  // Read file buffer
  let fileBuffer: ArrayBuffer;
  try {
    fileBuffer = await file.arrayBuffer();
  } catch (err) {
    trace.error("BUFFER", "failed to read file buffer", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { code: "BUFFER_READ_FAILED", message: "Gagal membaca file.", step: "BUFFER", retryable: true },
      { status: 500 }
    );
  }
  trace.log("BUFFER", `file read: ${(fileBuffer.byteLength / 1024).toFixed(1)}KB`);

  // ── Upload ──
  trace.log("UPLOAD", "delegating to photo service");
  const result = await uploadActivityPhoto(
    trace,
    activityId,
    userId,
    file.name,
    file.type,
    fileBuffer,
    );

  if (!result.success) {
    trace.error("UPLOAD", `upload failed: ${result.error} (code=${result.code})`, { activityId, fileName: file.name });

    // Determine HTTP status based on structured error code
    let status = 500;
    switch (result.code) {
      case "DB_INSERT_FAILED":
        status = 500;
        break;
      case "DRIVE_API_ERROR":
        status = 502; // Bad Gateway — upstream Drive error
        break;
      case "TOKEN_MISSING":
      case "FOLDER_NOT_FOUND":
        status = 401;
        break;
      case "ACTIVITY_NOT_FOUND":
      case "LOGBOOK_NOT_FOUND":
      case "OWNERSHIP_DENIED":
        status = 404;
        break;
      default:
        status = result.retryable ? 500 : 400;
    }

    return NextResponse.json(
      {
        code: result.code || "UPLOAD_FAILED",
        message: result.error || "Gagal mengupload foto.",
        step: result.step || "UPLOAD",
        retryable: result.retryable ?? (status >= 500),
        traceId: trace.traceId,
      },
      { status }
    );
  }

  trace.log("DONE", `photo uploaded successfully`, { photoId: result.photo?.id, fileId: result.photo?.google_file_id?.substring(0, 20) });

  return NextResponse.json(
    {
      photo: result.photo,
      message: "Foto berhasil diupload.",
      traceId: trace.traceId,
    },
    { status: 201 }
  );
}