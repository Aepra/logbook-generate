/**
 * Google Docs Service
 * ====================
 * ONLY Google Docs API calls live here.
 * This is a pure rendering layer — no data fetching, no business logic.
 */

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DOCS_API_BASE = "https://docs.googleapis.com/v1";
import { getServiceAccountToken } from "@/lib/google-service-account";

export interface DocRequest {
  accessToken: string;
  title: string;
  paragraphs: DocParagraph[];
}

export interface DocParagraph {
  text: string;
  bold?: boolean;
  fontSize?: number;
  indent?: number;
}

/**
 * Creates an empty Google Doc via Drive API.
 * Returns document ID or null on failure.
 */
async function createEmptyDoc(
  accessToken: string,
  title: string,
  parentFolderId?: string
): Promise<string | null> {
  try {
    const body: Record<string, unknown> = {
      name: title,
      mimeType: "application/vnd.google-apps.document",
    };

    if (parentFolderId) {
      body.parents = [parentFolderId];
    }

    const accessToken = await getServiceAccountToken();
    if (!accessToken) return null;

    const accessToken = await getServiceAccountToken();
    if (!accessToken) return false;

    const response = await fetch(`${DRIVE_API_BASE}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.error("[Docs Service] Gagal membuat dokumen:", title);
      return null;
    }

    const data = await response.json();
    return data.id as string;
  } catch (error) {
    console.error("[Docs Service] Error membuat dokumen:", error);
    return null;
  }
}

/**
 * Inserts content into a Google Doc using batchUpdate.
 * Uses a series of insertText and updateParagraphStyle requests.
 */
async function writeContentToDoc(
  accessToken: string,
  documentId: string,
  paragraphs: DocParagraph[]
): Promise<boolean> {
  try {
    // Build structured content with special markers for formatting
    // Strategy: insert all text as one batch, then apply formatting
    const fullText =
      paragraphs.map((p) => p.text).join("\n") + "\n";

    // Step 1: Insert all text at index 1 (after the empty document's implicit newline)
    const requests: unknown[] = [
      {
        insertText: {
          location: { index: 1 },
          text: fullText,
        },
      },
    ];

    // Step 2: Apply formatting for each paragraph
    let currentIndex = 1;
    for (const para of paragraphs) {
      const textLength = para.text.length;
      const startIndex = currentIndex;
      const endIndex = currentIndex + textLength;

      // Bold formatting for title/header paragraphs
      if (para.bold) {
        requests.push({
          updateTextStyle: {
            range: {
              startIndex,
              endIndex,
            },
            textStyle: {
              bold: true,
              fontSize: {
                magnitude: para.fontSize || 11,
                unit: "PT",
              },
            },
            fields: "bold,fontSize",
          },
        });
      }

      // Indentation for nested content
      if (para.indent && para.indent > 0) {
        requests.push({
          updateParagraphStyle: {
            range: {
              startIndex,
              endIndex,
            },
            paragraphStyle: {
              indentFirstLine: {
                magnitude: para.indent * 18, // ~0.25 inch per level
                unit: "PT",
              },
              indentStart: {
                magnitude: para.indent * 18,
                unit: "PT",
              },
            },
            fields: "indentFirstLine,indentStart",
          },
        });
      }

      // Move past this paragraph + newline character
      currentIndex = endIndex + 1;
    }

    const response = await fetch(
      `${DOCS_API_BASE}/documents/${documentId}:batchUpdate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requests }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      console.error("[Docs Service] Gagal menulis konten:", errorBody);
      return false;
    }

    return true;
  } catch (error) {
    console.error("[Docs Service] Error menulis konten:", error);
    return false;
  }
}

/**
 * Creates a fully populated Google Doc from structured paragraphs.
 * Returns the document URL or null on failure.
 */
export async function createDocumentFromParagraphs(
  request: DocRequest
): Promise<string | null> {
  const docId = await createEmptyDoc(
    request.accessToken,
    request.title
  );

  if (!docId) return null;

  const written = await writeContentToDoc(
    request.accessToken,
    docId,
    request.paragraphs
  );

  if (!written) return null;

  return `https://docs.google.com/document/d/${docId}/edit`;
}

/**
 * Formats a single date string (YYYY-MM-DD) to Indonesian display format.
 */
function formatDateLong(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Builds structured DocParagraph array from logbook data.
 * This is the pure data → structure mapping function.
 * No API calls, no side effects.
 */
export function buildDocumentStructure(params: {
  logbookTitle: string;
  logbookDescription: string;
  logbookType: string;
  userName: string;
  groupedActivities: {
    date: string;
    activities: {
      start_time: string | null;
      end_time: string | null;
      title: string;
      description: string;
      obstacle: string;
    }[];
  }[];
}): DocParagraph[] {
  const paragraphs: DocParagraph[] = [];

  // ————— TITLE —————
  paragraphs.push({
    text: params.logbookTitle,
    bold: true,
    fontSize: 18,
  });
  paragraphs.push({ text: "" }); // blank line

  // ————— SECTION 1: INFO —————
  paragraphs.push({
    text: "INFORMASI LOGBOOK",
    bold: true,
    fontSize: 14,
  });
  paragraphs.push({ text: "" });

  paragraphs.push({
    text: `Nama: ${params.userName}`,
    fontSize: 11,
  });

  const typeLabel =
    params.logbookType === "pkl"
      ? "PKL"
      : params.logbookType === "kkn"
      ? "KKN"
      : "Lainnya";
  paragraphs.push({
    text: `Tipe: ${typeLabel}`,
    fontSize: 11,
  });

  if (params.logbookDescription) {
    paragraphs.push({
      text: `Deskripsi: ${params.logbookDescription}`,
      fontSize: 11,
    });
  }

  paragraphs.push({ text: "" });

  // ————— SECTION 2: DAILY LOGS —————
  paragraphs.push({
    text: "CATATAN HARIAN",
    bold: true,
    fontSize: 14,
  });
  paragraphs.push({ text: "" });

  if (params.groupedActivities.length === 0) {
    paragraphs.push({
      text: "Belum ada aktivitas yang dicatat.",
      fontSize: 11,
    });
  } else {
    for (const group of params.groupedActivities) {
      // Date header
      paragraphs.push({
        text: `📅 ${formatDateLong(group.date)}`,
        bold: true,
        fontSize: 12,
      });

      for (const activity of group.activities) {
        const timeStr =
          activity.start_time && activity.end_time
            ? `${activity.start_time} - ${activity.end_time}`
            : activity.start_time
            ? `${activity.start_time}`
            : "";

        const titleLine = timeStr
          ? `${timeStr} | ${activity.title}`
          : activity.title;

        paragraphs.push({
          text: titleLine,
          indent: 1,
          fontSize: 11,
        });

        if (activity.description) {
          paragraphs.push({
            text: activity.description,
            indent: 2,
            fontSize: 10,
          });
        }

        if (activity.obstacle) {
          paragraphs.push({
            text: `Kendala: ${activity.obstacle}`,
            indent: 2,
            fontSize: 10,
          });
        }
      }

      paragraphs.push({ text: "" }); // spacing between days
    }
  }

  return paragraphs;
}