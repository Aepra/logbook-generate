/**
 * Ekspor PDF Service
 * ==================
 * Generates a PDF of the logbook using docxtemplater and converting it
 * to PDF via Google Drive API to ensure 100% template alignment.
 */

import { generateLogbookDocx } from "./export-docx.service";
import { convertDocxToPdf } from "./google-drive.service";
import { createTraceContext } from "@/types/drive";
import { refreshAccessToken } from "@/lib/token-refresh";

export async function generateLogbookPdf(params: {
  logbook: any;
  activities: any[];
  user: any;
  accessToken: string;
  refreshToken?: string;
  isPreview?: boolean;
}): Promise<Buffer> {
  const { logbook, activities, user, accessToken, refreshToken, isPreview } = params;

  // 1. Generate the DOCX using docxtemplater
  const docxBuffer = await generateLogbookDocx({
    logbook,
    activities,
    user,
    accessToken,
    refreshToken,
  });

  // 2. Convert the DOCX buffer to PDF using Google Drive API
  const trace = createTraceContext(`pdf_export_${logbook?.id?.substring(0, 8) || "temp"}`);
  
  const refreshFn = async () => {
    if (!refreshToken) return null;
    try {
      const result = await refreshAccessToken({ refreshToken });
      return result.accessToken || null;
    } catch {
      return null;
    }
  };

  const pdfBuffer = await convertDocxToPdf(trace, docxBuffer);

  if (!pdfBuffer) {
    throw new Error("Gagal mengonversi dokumen DOCX ke PDF melalui Google Drive API.");
  }

  return pdfBuffer;
}

