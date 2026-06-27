/**
 * Export Service
 * ===============
 * Orchestration layer for export operations.
 * Coordinates between domain services (logbook, activity) and
 * the rendering service (google-docs).
 *
 * This service is READ-ONLY — it never modifies data.
 * It only reads existing data and delegates document creation.
 */

import { supabaseAdmin } from "@/lib/supabase-server";
import { getLogbookById } from "@/services/logbook.service";
import { getActivitiesGroupedByDate } from "@/services/activity.service";
import {
  createDocumentFromParagraphs,
  buildDocumentStructure,
} from "@/services/google-docs.service";
import type { ActivitiesByDate } from "@/services/activity.service";

export interface ExportResult {
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * Exports a logbook to Google Docs.
 *
 * Flow:
 * 1. Fetch logbook (user-scoped)           → logbook.service
 * 2. Fetch grouped activities               → activity.service
 * 3. Build document structure               → google-docs.service (pure function)
 * 4. Create & populate Google Doc           → google-docs.service (API call)
 * 5. Return document URL
 *
 * This is READ-ONLY — no data is modified.
 */
export async function exportLogbookToGoogleDocs(
  logbookId: string,
  userId: string
): Promise<ExportResult> {
  try {
    // Step 1: Fetch logbook (user-scoped validation built into service)
    const logbook = await getLogbookById(logbookId, userId);

    if (!logbook) {
      return {
        success: false,
        error: "Logbook tidak ditemukan.",
      };
    }

    // Step 2: Fetch grouped activities (reuses existing activity service)
    const groupedActivities: ActivitiesByDate[] =
      await getActivitiesGroupedByDate(logbookId);

    // Step 3: Get user name from database
    const { data: userData } = await supabaseAdmin
      .from("users")
      .select("name")
      .eq("id", userId)
      .single();

    const userName = userData?.name || "User";

    // Step 4: Build document structure (pure function, no side effects)
    const paragraphs = buildDocumentStructure({
      logbookTitle: logbook.title,
      logbookDescription: logbook.description || "",
      logbookType: logbook.type,
      userName,
      groupedActivities: groupedActivities.map((group) => ({
        date: group.date,
        activities: group.activities.map((a) => ({
          start_time: a.start_time,
          end_time: a.end_time,
          title: a.title,
          description: a.description,
          obstacle: a.obstacle,
        })),
      })),
    });

    // Step 5: Create Google Doc (API call)
    const docUrl = await createDocumentFromParagraphs({
      title: `LogBook - ${logbook.title}`,
      paragraphs,
    });

    if (!docUrl) {
      return {
        success: false,
        error:
          "Gagal membuat dokumen Google Docs. Silakan coba lagi.",
      };
    }

    return {
      success: true,
      url: docUrl,
    };
  } catch (error) {
    console.error("[Export Service] Error:", error);
    return {
      success: false,
      error: "Terjadi kesalahan saat mengexport logbook.",
    };
  }
}