import { getServerSession } from "next-auth/next";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { supabaseAdmin } from "@/lib/supabase-server";
import { createTraceContext } from "@/types/drive";
import {
  listDriveFolderContents,
  buildFolderPathChain,
  verifyDriveFolderId,
  getDriveFileMeta,
} from "@/services/google-drive.service";

/**
 * Debug endpoint: Inspect Google Drive folder structure for a user.
 * 
 * Query params:
 *   ?folderId=<drive-folder-id> - List contents of a specific Drive folder
 *   ?logbook_id=<uuid>          - List Drive folder contents for a logbook's owner
 *   ?verify=true                - Also verify each file/folder exists in Drive
 *   ?fileId=<drive-file-id>     - Get metadata for a specific Drive file
 * 
 * This is a DEVELOPMENT-ONLY endpoint for debugging Drive integrity.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  console.log("[DRIVE DEBUG] Session:", session?.user?.email);

  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const trace = createTraceContext("debug_drive");
  const noopRefresh = async () => null; // debug endpoint uses fresh token
  const accessToken = session.accessToken;
  if (!accessToken) {
    return NextResponse.json(
      { error: "No access token — re-login required" },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const logbookId = searchParams.get("logbook_id");
  const folderId = searchParams.get("folderId");
  const fileIdParam = searchParams.get("fileId");
  const verify = searchParams.get("verify") === "true";

  const result: Record<string, unknown> = {
    user: session.user.email,
    timestamp: new Date().toISOString(),
  };

  // Mode 1: Get file metadata by Drive fileId
  if (fileIdParam) {
    const fileMeta = await getDriveFileMeta(trace,  fileIdParam);
    if (!fileMeta) {
      result.file = null;
      result.error = "File not found in Drive or access denied";
    } else {
      result.file = fileMeta;
      // Build path chain
      const chain = await buildFolderPathChain(trace,  fileIdParam);
      result.filePath = chain;
    }
    return NextResponse.json(result);
  }

  // Mode 2: List contents of a specific Drive folder
  if (folderId) {
    const folderVerify = await verifyDriveFolderId(trace,  folderId);
    result.folderCheck = folderVerify ? {
      valid: true,
      name: folderVerify.name,
      id: folderVerify.id,
      parents: folderVerify.parents,
    } : {
      valid: false,
      error: "Not a valid Drive folder ID",
    };

    const contents = await listDriveFolderContents(trace,  folderId);
    result.contents = contents;
    result.totalItems = contents.length;

    // Build path for the folder itself
    const chain = await buildFolderPathChain(trace,  folderId);
    result.folderPath = chain;

    return NextResponse.json(result);
  }

  // Mode 3: Debug by logbook — get user info + Drive folder structure
  if (logbookId) {
    // Get logbook info
    const { data: logbook } = await supabaseAdmin
      .from("logbooks")
      .select("id, title, user_id, drive_folder_id")
      .eq("id", logbookId)
      .single();

    if (!logbook) {
      result.error = "Logbook not found";
      return NextResponse.json(result, { status: 404 });
    }

    result.logbook = logbook;

    // Get user info
    const { data: userData } = await supabaseAdmin
      .from("users")
      .select("id, email, drive_folder_id")
      .eq("id", logbook.user_id)
      .single();

    if (!userData) {
      result.userDb = null;
      result.error = "User not found in DB";
      return NextResponse.json(result, { status: 404 });
    }

    result.userDb = userData;

    // Verify stored drive_folder_id is a valid Drive folder
    const storedFolderId = userData.drive_folder_id;
    result.storedFolderId = storedFolderId;

    if (storedFolderId) {
      const folderCheck = await verifyDriveFolderId(trace,  storedFolderId);
      result.folderIdValidInDrive = !!folderCheck;

      if (folderCheck) {
        result.folderDriveName = folderCheck.name;
        result.folderDriveParents = folderCheck.parents;

        // Build the full path chain from root
        const chain = await buildFolderPathChain(trace,  storedFolderId);
        result.folderPathChain = chain;

        // List all contents recursively
        const userFolderContents = await listDriveFolderContents(trace,  storedFolderId);
        result.userFolderContents = userFolderContents;
        result.totalFiles = userFolderContents.length;

        // If verify mode, check each file
        if (verify && userFolderContents.length > 0) {
          const fileVerifications: Array<Record<string, unknown>> = [];
          for (const file of userFolderContents) {
            const meta = await getDriveFileMeta(trace,  file.id);
            fileVerifications.push({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              verified: !!meta,
              parents: meta?.parents || file.parents,
              webViewLink: meta?.webViewLink?.substring(0, 100),
            });
          }
          result.fileVerifications = fileVerifications;
        }

        // Also check LogBook.ID root level
        const rootFolderId = await findDriveRoot(accessToken);
        result.rootFolderId = rootFolderId;

        if (rootFolderId) {
          const rootContents = await listDriveFolderContents(trace,  rootFolderId);
          result.rootLevelFolders = rootContents.map(f => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
          }));
        }
      } else {
        result.folderIdInvalid = true;
        result.folderIdInDriveNull = true;
      }
    } else {
      result.noFolderIdStored = true;
    }

    return NextResponse.json(result);
  }

  // Mode 4: No params — show user's Drive root folder info
  result.message = "Provide ?folderId=, ?logbook_id=, ?fileId=, or ?verify=true to debug";

  // Try to find the user's root folder by email
  const { data: userData } = await supabaseAdmin
    .from("users")
    .select("drive_folder_id, email")
    .eq("email", session.user.email)
    .single();

  if (userData?.drive_folder_id) {
    const folderCheck = await verifyDriveFolderId(trace,  userData.drive_folder_id);
    result.yourDriveFolder = {
      storedId: userData.drive_folder_id,
      validInDrive: !!folderCheck,
      driveName: folderCheck?.name,
    };
  }

  return NextResponse.json(result);
}

/**
 * Helper: Find LogBook.ID root folder by name.
 */
async function findDriveRoot(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_DRIVE_API_BASE || "https://www.googleapis.com/drive/v3"}/files?q=${encodeURIComponent("name='LogBook.ID' and mimeType='application/vnd.google-apps.folder' and trashed=false")}&fields=files(id,name)`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.files?.[0]?.id || null;
  } catch {
    return null;
  }
}