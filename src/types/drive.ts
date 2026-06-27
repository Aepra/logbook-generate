/**
 * Structured error returned by all service operations.
 *
 * Every Drive/photo operation returns this shape on failure,
 * enabling the caller to decide retry vs abort vs relogin.
 */
export interface DriveError {
  code:
    | "TOKEN_EXPIRED"
    | "TOKEN_REFRESH_FAILED"
    | "TOKEN_MISSING"
    | "FOLDER_NOT_FOUND"
    | "FOLDER_CREATE_FAILED"
    | "UPLOAD_FAILED"
    | "UPLOAD_VERIFICATION_FAILED"
    | "FILE_TOO_LARGE"
    | "INVALID_FILE_NAME"
    | "TOO_MANY_FILES"
    | "DRIVE_API_ERROR"
    | "DATABASE_ERROR"
    | "DB_INSERT_FAILED"
    | "ACTIVITY_NOT_FOUND"
    | "LOGBOOK_NOT_FOUND"
    | "USER_NOT_FOUND"
    | "OWNERSHIP_DENIED"
    | "UNKNOWN"
    | "UPLOAD_NETWORK_ERROR";
  message: string;
  /** Which step in the pipeline this error originated from */
  step: string;
  /** If true, caller may retry the same operation */
  retryable: boolean;
}

/**
 * Context propagated through the entire upload pipeline.
 */
export interface TraceContext {
  traceId: string;
  log(step: string, msg: string, data?: Record<string, unknown>): void;
  warn(step: string, msg: string, data?: Record<string, unknown>): void;
  error(step: string, msg: string, data?: Record<string, unknown>): void;
}

export function createTraceContext(traceId?: string): TraceContext {
  const id = traceId || crypto.randomUUID?.() || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    traceId: id,
    log(step, msg, data) {
      const extra = data ? ` ${JSON.stringify(data)}` : "";
      console.log(`[UPLOAD:${id}] [${step}] ${msg}${extra}`);
    },
    warn(step, msg, data) {
      const extra = data ? ` ${JSON.stringify(data)}` : "";
      console.warn(`[UPLOAD:${id}] [${step}] ${msg}${extra}`);
    },
    error(step, msg, data) {
      const extra = data ? ` ${JSON.stringify(data)}` : "";
      console.error(`[UPLOAD:${id}] [${step}] ${msg}${extra}`);
    },
  };
}

export interface UploadFileParams {
  trace: TraceContext;
  fileBuffer: ArrayBuffer;
  fileName: string;
  mimeType: string;
  userRootFolderId: string;
  logbookId: string;
  /** User email for repairing stale/deleted root Drive folder */
  userEmail: string;
}

export interface UploadFileResult {
  fileId: string;
  webViewLink: string;
}