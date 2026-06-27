/**
 * Photo Service — v2
 * ===================
 * Business logic for photo operations.
 * Coordinates between API route and google-drive.service.
 *
 * v2 changes:
 *   - logbookId as folder key (was logbookTitle) — matches Drive service v2
 *   - TraceContext logging (trace.log instead of console.log)
 *   - refreshToken callback passed through to Drive service
 *   - Structured errors via DriveError
 *   - Single path for activity → logbook query (removed redundant verifyActivityOwnership)
 */

import { supabaseAdmin } from "@/lib/supabase-server";
import type { TraceContext, DriveError } from "@/types/drive";
import { uploadFileToActivityFolder, deleteDriveFile } from "@/services/google-drive.service";

export interface PhotoRecord {
  id: string;
  activity_id: string;
  google_file_id: string;
  google_drive_url: string;
  created_at: string;
}

export interface PhotoUploadResult {
  success: boolean;
  photo?: PhotoRecord;
  error?: string;
  /** Structured error code for reliable client-side handling (v2) */
  code?: string;
  /** Which step failed (v2) */
  step?: string;
  /** Whether this error may be retried (v2) */
  retryable?: boolean;
}

// ─────────────────────────────────────
//  INTERNAL HELPERS
// ─────────────────────────────────────

/**
 * Saves photo metadata to Supabase photos table.
 */
async function savePhotoMetadata(
  activityId: string,
  googleFileId: string,
  googleDriveUrl: string
): Promise<PhotoRecord> {
  const { data, error } = await supabaseAdmin
    .from("photos")
    .insert({
      activity_id: activityId,
      google_file_id: googleFileId,
      google_drive_url: googleDriveUrl,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Gagal menyimpan metadata foto: ${error.message}`);
  }

  return data as PhotoRecord;
}

// ─────────────────────────────────────
//  EXPORTED: GETTERS
// ─────────────────────────────────────

/**
 * Gets all photos for a given activity, ordered by creation date.
 */
export async function getPhotosByActivityId(
  activityId: string
): Promise<PhotoRecord[]> {
  const { data, error } = await supabaseAdmin
    .from("photos")
    .select("*")
    .eq("activity_id", activityId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[Photo Service] Gagal mengambil foto:", error.message);
    return [];
  }

  return (data as PhotoRecord[]) || [];
}

/**
 * Gets all photos grouped by activity IDs (batch query).
 * Returns Map<activityId, PhotoRecord[]>
 */
export async function getPhotosByActivityIds(
  activityIds: string[]
): Promise<Map<string, PhotoRecord[]>> {
  if (activityIds.length === 0) return new Map();

  const grouped = new Map<string, PhotoRecord[]>();
  
  // Chunk the activityIds to avoid URL length limits
  const chunkSize = 20;
  for (let i = 0; i < activityIds.length; i += chunkSize) {
    const chunk = activityIds.slice(i, i + chunkSize);
    
    const { data, error } = await supabaseAdmin
      .from("photos")
      .select("*")
      .in("activity_id", chunk)
      .order("created_at", { ascending: true });

    if (error || !data) {
      console.error("[Photo Service] Gagal mengambil batch foto (chunk):", error?.message);
      continue; // keep going with other chunks
    }

    for (const photo of data as PhotoRecord[]) {
      const existing = grouped.get(photo.activity_id) || [];
      existing.push(photo);
      grouped.set(photo.activity_id, existing);
    }
  }

  return grouped;
}

// ─────────────────────────────────────
//  EXPORTED: UPLOAD — v2
// ─────────────────────────────────────

/**
 * Uploads a photo for an activity.
 *
 * Flow:
 * 1. Fetch activity → get logbook_id
 * 2. Fetch logbook → get logbook title (for folder chain)
 * 3. Fetch user → get drive_folder_id
 * 4. Upload file to Google Drive (logbookId as folder key)
 * 5. Save metadata to Supabase photos table
 * 6. Return photo record
 */
export async function uploadActivityPhoto(
  trace: TraceContext,
  activityId: string,
  userId: string,
  fileName: string,
  mimeType: string,
  fileBuffer: ArrayBuffer
): Promise<PhotoUploadResult> {
  try {
    // ── Step 1: Validate ownership via single chain query ──
    trace.log("UPLOAD", "Step 1: fetching activity from DB");
    const { data: activity, error: activityError } = await supabaseAdmin
      .from("activities")
      .select("logbook_id")
      .eq("id", activityId)
      .single();

    if (activityError || !activity) {
      trace.error("UPLOAD", "activity not found", { error: activityError?.message });
      return { success: false, error: "Activity tidak ditemukan.", code: "ACTIVITY_NOT_FOUND", step: "STEP1_ACTIVITY", retryable: false };
    }

    const logbookId = activity.logbook_id;
    trace.log("UPLOAD", "Step 1a: logbook_id resolved", { logbookId });

    // ── Step 2: Fetch logbook details (title only needed for metadata; Drive uses logbookId) ──
    trace.log("UPLOAD", "Step 2: fetching logbook", { logbookId });
    const { data: logbook, error: logbookError } = await supabaseAdmin
      .from("logbooks")
      .select("title, user_id")
      .eq("id", logbookId)
      .single();

    if (logbookError || !logbook) {
      trace.error("UPLOAD", "logbook not found", { error: logbookError?.message, code: logbookError?.code });
      return { success: false, error: "Logbook tidak ditemukan.", code: "LOGBOOK_NOT_FOUND", step: "STEP2_LOGBOOK", retryable: false };
    }

    // Verify ownership: logbook must belong to this user
    if (logbook.user_id !== userId) {
      trace.error("UPLOAD", "ownership denied", { logbookUserId: logbook.user_id, userId });
      return { success: false, error: "Anda tidak memiliki akses ke activity ini.", code: "OWNERSHIP_DENIED", step: "STEP2_OWNERSHIP", retryable: false };
    }

    trace.log("UPLOAD", "Step 2a: ownership verified", { title: logbook.title });

    // ── Step 3: Get user's root folder ID ──
    trace.log("UPLOAD", "Step 3: fetching user from DB", { userId });
    const { data: userData, error: userError } = await supabaseAdmin
      .from("users")
      .select("drive_folder_id, email, name")
      .eq("id", userId)
      .single();

    if (userError || !userData) {
      trace.error("UPLOAD", "user not found", { error: userError?.message });
      return { success: false, error: "User tidak ditemukan.", code: "USER_NOT_FOUND", step: "STEP3_USER", retryable: false };
    }

    if (!userData.drive_folder_id) {
      trace.error("UPLOAD", "no drive_folder_id for user");
      return {
        success: false,
        error: "Drive root folder belum tersedia. Silakan login ulang.",
        code: "FOLDER_NOT_FOUND",
        step: "STEP3_ROOT_FOLDER",
        retryable: false,
      };
    }

    trace.log("UPLOAD", "Step 3a: user data OK", { driveFolderId: userData.drive_folder_id?.substring(0, 10) + "...", email: userData.email, name: userData.name });

    // ── Step 4: Upload file to Drive (logbookId as folder key) ──
    trace.log("UPLOAD", "Step 4: uploading to Drive", { fileName, logbookId });
    const userName = userData.name || userData.email?.split("@")[0] || "UnknownUser";
    const uploadResult = await uploadFileToActivityFolder({
      trace,
      fileBuffer,
      fileName,
      mimeType,
      userRootFolderId: userData.drive_folder_id,
      logbookId,
      userName, // v2: pass name for Drive folder repair
    });

    if (!uploadResult) {
      trace.error("UPLOAD", "Drive upload returned null");
      return {
        success: false,
        error: "Gagal mengupload file ke Google Drive.",
        code: "DRIVE_API_ERROR",
        step: "UPLOAD_TO_DRIVE",
        retryable: true,
      };
    }

    trace.log("UPLOAD", "Step 4a: upload success", { fileId: uploadResult.fileId });

    // ── Step 5: Save metadata to Supabase ──
    trace.log("UPLOAD", "Step 5: saving to DB");
    try {
      const photo = await savePhotoMetadata(
        activityId,
        uploadResult.fileId,
        uploadResult.webViewLink
      );

      trace.log("UPLOAD", "Step 5a: photo saved", { photoId: photo.id });
      return { success: true, photo };
    } catch (dbError) {
      // ORPHAN FILE SAFETY FIX
      // Drive upload succeeded but DB insert failed.
      // Best-effort cleanup: delete the orphan file from Drive.
      trace.warn("UPLOAD", "DB insert failed — cleaning up orphan Drive file", { fileId: uploadResult.fileId });
      const cleaned = await deleteDriveFile(trace, uploadResult.fileId);
      if (cleaned) {
        trace.log("UPLOAD", "orphan file cleaned from Drive", { fileId: uploadResult.fileId });
      } else {
        trace.error("UPLOAD", "could not clean up orphan file", { fileId: uploadResult.fileId });
      }

      const dbMsg = dbError instanceof Error ? dbError.message : "Gagal menyimpan metadata foto.";
      trace.error("UPLOAD", `DB insert failed after Drive upload`, { message: dbMsg });
      return {
        success: false,
        error: "Foto berhasil diupload ke Drive tetapi gagal disimpan di database. Silakan refresh.",
        code: "DB_INSERT_FAILED",
        step: "SAVE_METADATA",
        retryable: true,
      };
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Terjadi kesalahan saat upload.";
    trace.error("UPLOAD", `unhandled error: ${message}`);
    return { success: false, error: message, code: "UNKNOWN", step: "UNKNOWN", retryable: false };
  }
}

// ─────────────────────────────────────
//  EXPORTED: DELETE
// ─────────────────────────────────────

/**
 * Deletes a photo (metadata only — Drive file deletion is optional).
 * Only the owner of the activity can delete photos.
 */
export async function deletePhoto(
  photoId: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Verify photo exists and belongs to user's activity
    const { data: photo, error: photoError } = await supabaseAdmin
      .from("photos")
      .select("activity_id")
      .eq("id", photoId)
      .single();

    if (photoError || !photo) {
      return { success: false, error: "Foto tidak ditemukan." };
    }

    // Verify ownership via activity → logbook chain
    const { data: activity, error: actError } = await supabaseAdmin
      .from("activities")
      .select("logbook_id")
      .eq("id", photo.activity_id)
      .single();

    if (actError || !activity) {
      return { success: false, error: "Activity tidak ditemukan." };
    }

    const { data: logbook, error: logError } = await supabaseAdmin
      .from("logbooks")
      .select("id")
      .eq("id", activity.logbook_id)
      .eq("user_id", userId)
      .single();

    if (logError || !logbook) {
      return { success: false, error: "Anda tidak memiliki akses ke foto ini." };
    }

    // Delete metadata from Supabase
    const { error: deleteError } = await supabaseAdmin
      .from("photos")
      .delete()
      .eq("id", photoId);

    if (deleteError) {
      return {
        success: false,
        error: `Gagal menghapus foto: ${deleteError.message}`,
      };
    }

    return { success: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Terjadi kesalahan.";
    return { success: false, error: message };
  }
}