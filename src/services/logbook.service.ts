import { supabaseAdmin } from "@/lib/supabase-server";

export type LogbookType = "pkl" | "kkn" | "other";

export interface CreateLogbookInput {
  title: string;
  description: string;
  type: LogbookType;
  start_date?: string;
  end_date?: string;
}

export interface UpdateLogbookInput {
  title?: string;
  description?: string;
  type?: LogbookType;
  status?: string;
  location?: string;
  institution_name?: string;
  supervisor_name?: string;
  mentor_name?: string;
  start_date?: string;
  end_date?: string;
}

export interface Logbook {
  id: string;
  user_id: string;
  title: string;
  description: string;
  type: LogbookType;
  created_at: string;
  drive_folder_id: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

/**
 * Creates a logbook in the database AND optionally creates
 * a corresponding Drive subfolder.
 *
 * Drive failure is NON-BLOCKING — logbook is created regardless.
 */
export async function createLogbook(
  userId: string,
  input: CreateLogbookInput
): Promise<Logbook> {
  // 1. Insert logbook into database first
  const insertData: Record<string, unknown> = {
    user_id: userId,
    title: input.title,
    description: input.description,
    type: input.type,
  };

  if (input.start_date) insertData.start_date = input.start_date;
  if (input.end_date) insertData.end_date = input.end_date;

  const { data, error } = await supabaseAdmin
    .from("logbooks")
    .insert(insertData)
    .select()
    .single();

  if (error) {
    throw new Error(`Gagal membuat logbook: ${error.message}`);
  }

  const logbook = data as Logbook;

  return logbook;
}

export async function getUserLogbooks(userId: string): Promise<Logbook[]> {
  const { data, error } = await supabaseAdmin
    .from("logbooks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Gagal mengambil logbook: ${error.message}`);
  }

  return (data as Logbook[]) || [];
}

export async function getTotalLogbooks(userId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("logbooks")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  if (error) {
    console.error("[Logbook Service] Gagal menghitung logbook:", error.message);
    return 0;
  }

  return count || 0;
}

export async function getRecentLogbooks(
  userId: string,
  limit: number = 5
): Promise<Logbook[]> {
  const { data, error } = await supabaseAdmin
    .from("logbooks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[Logbook Service] Gagal mengambil recent logbooks:", error.message);
    return [];
  }

  return (data as Logbook[]) || [];
}

export interface LogbookWithStats extends Logbook {
  total_days: number;
  total_activities: number;
  total_photos: number;
  progress_percent: number;
  start_date?: string;
  end_date?: string;
  activity_count_by_date?: Record<string, number>;
  status?: string;
  location?: string;
  institution_name?: string;
  supervisor_name?: string;
  mentor_name?: string;
  remaining_days: number;
}

/**
 * Resolve the effective date range for a logbook.
 *
 * PRIORITY:
 *   1. Use logbook.start_date / logbook.end_date from DB (user input) — PRIMARY
 *   2. Fallback to min/max activity dates if DB values are null/undefined
 *   3. Return [undefined, undefined] if neither source has data
 */
function resolveDateRange(
  dbStart: string | null | undefined,
  dbEnd: string | null | undefined,
  activityDates: string[]
): [string | undefined, string | undefined] {
  // PRIMARY: use database values from user input
  if (dbStart && dbEnd) {
    return [dbStart, dbEnd];
  }

  // Fallback: derive from activities
  if (activityDates.length > 0) {
    const sorted = [...activityDates].sort();
    return [sorted[0], sorted[sorted.length - 1]];
  }

  // If only one DB value exists, use it with fallback for the other
  if (dbStart) return [dbStart, undefined];
  if (dbEnd) return [undefined, dbEnd];

  return [undefined, undefined];
}

/**
 * Calculate progress using a hybrid formula:
 *
 *   timeProgress = elapsed days from start → today (clamped to end) / total range
 *   activityProgress = unique activity days / total range
 *
 *   FINAL = (0.6 × timeProgress) + (0.4 × activityProgress)
 *
 * Returns a number between 0 and 100.
 */
function calculateHybridProgress(
  startDate: string,
  endDate: string,
  uniqueActivityHari: number
): number {
  const start = new Date(startDate + "T00:00:00Z").getTime();
  const end = new Date(endDate + "T00:00:00Z").getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const now = today.getTime();

  const totalRangeMs = end - start;
  const totalHari = Math.max(1, Math.round(totalRangeMs / 86400000) + 1);

  // Time-based progress: elapsed from start to today (clamped to end)
  const elapsedMs = Math.max(0, Math.min(now, end) - start);
  const elapsedHari = Math.round(elapsedMs / 86400000);
  const timeProgress = Math.min(1, elapsedHari / totalHari);

  // Activity-based progress: unique days filled / total range
  const activityProgress = Math.min(1, uniqueActivityHari / totalHari);

  // Hybrid: 60% time + 40% activity
  const hybrid = 0.6 * timeProgress + 0.4 * activityProgress;

  return Math.min(100, Math.round(hybrid * 100));
}

/**
 * OPTIMIZED: Uses batch queries instead of N+1 pattern.
 * Now does only 3 queries total regardless of number of logbooks.
 */
export async function getUserLogbooksWithStats(userId: string): Promise<LogbookWithStats[]> {
  // Query 1: Get all logbooks
  const { data: logbooks, error } = await supabaseAdmin
    .from("logbooks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[Logbook Service] Gagal mengambil logbook:", error.message);
    return [];
  }

  if (!logbooks || logbooks.length === 0) return [];

  const logbookIds = logbooks.map((l: Logbook) => l.id);

  // Query 2: Get ALL activities for ALL logbooks in one query (batch)
  const { data: allActivities } = await supabaseAdmin
    .from("activities")
    .select("id, logbook_id, activity_date")
    .in("logbook_id", logbookIds);

  const activitiesList = (allActivities || []) as Array<{ id: string; logbook_id: string; activity_date: string }>;

  // Group activities by logbook_id in memory (fast)
  const activitiesByLogbook = new Map<string, Array<{ id: string; activity_date: string }>>();
  for (const act of activitiesList) {
    if (!activitiesByLogbook.has(act.logbook_id)) {
      activitiesByLogbook.set(act.logbook_id, []);
    }
    activitiesByLogbook.get(act.logbook_id)!.push({ id: act.id, activity_date: act.activity_date });
  }

  // Build a map of logbook_id → activity IDs for photo query
  const activityIdsByLogbook = new Map<string, string[]>();
  for (const act of activitiesList) {
    if (!activityIdsByLogbook.has(act.logbook_id)) {
      activityIdsByLogbook.set(act.logbook_id, []);
    }
    activityIdsByLogbook.get(act.logbook_id)!.push(act.id);
  }

  // Query 3: Get photo counts per logbook using a join approach
  // We get photos for all activities at once, then group in memory
  const allActivityIds = activitiesList.map(a => a.id);
  const photoCountsByLogbook = new Map<string, number>();

  if (allActivityIds.length > 0) {
    const { data: photos } = await supabaseAdmin
      .from("photos")
      .select("activity_id")
      .in("activity_id", allActivityIds);

    if (photos) {
      // Build activity_id → logbook_id lookup
      const activityToLogbook = new Map<string, string>();
      for (const act of activitiesList) {
        activityToLogbook.set(act.id, act.logbook_id);
      }

      // Count photos per logbook
      for (const photo of photos) {
        const lbId = activityToLogbook.get(photo.activity_id);
        if (lbId) {
          photoCountsByLogbook.set(lbId, (photoCountsByLogbook.get(lbId) || 0) + 1);
        }
      }
    }
  }

  const result: LogbookWithStats[] = [];

  for (const logbook of logbooks as Logbook[]) {
    const logbookActivities = activitiesByLogbook.get(logbook.id) || [];
    const totalActivities = logbookActivities.length;
    const uniqueDates = new Set(logbookActivities.map((a) => a.activity_date));
    const totalHari = uniqueDates.size;

    // Get activity date strings for fallback
    const activityDateStrings = Array.from(uniqueDates);

    // Resolve date range: DB values PRIMARY → activity fallback
    const [startDate, endDate] = resolveDateRange(
      logbook.start_date,
      logbook.end_date,
      activityDateStrings
    );

    // Get photo count from the map
    const totalPhotos = photoCountsByLogbook.get(logbook.id) || 0;

    // Calculate progress using hybrid formula
    let progressPercent = 0;
    if (startDate && endDate) {
      progressPercent = calculateHybridProgress(startDate, endDate, totalHari);
    }

    // Count activities by date
    const activityCountByDate: Record<string, number> = {};
    for (const a of logbookActivities) {
      activityCountByDate[a.activity_date] = (activityCountByDate[a.activity_date] || 0) + 1;
    }

    // Calculate remaining days
    let remainingHari = 0;
    if (startDate && endDate) {
      const end = new Date(endDate + "T00:00:00Z").getTime();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const now = today.getTime();
      remainingHari = Math.max(0, Math.round((end - now) / 86400000));
    }

    const logbookData = logbook as Logbook & Record<string, unknown>;

    result.push({
      ...logbook,
      total_days: totalHari,
      total_activities: totalActivities,
      total_photos: totalPhotos,
      progress_percent: Math.min(100, progressPercent),
      start_date: startDate,
      end_date: endDate,
      activity_count_by_date: activityCountByDate,
      status: (logbookData as any).status || undefined,
      location: (logbookData as any).location || undefined,
      institution_name: (logbookData as any).institution_name || undefined,
      supervisor_name: (logbookData as any).supervisor_name || undefined,
      mentor_name: (logbookData as any).mentor_name || undefined,
      remaining_days: remainingHari,
    });
  }

  return result;
}

export async function deleteLogbook(
  logbookId: string,
  userId: string,
  driveAccessToken?: string
): Promise<void> {
  // Verify ownership
  const { data: logbook } = await supabaseAdmin
    .from("logbooks")
    .select("id")
    .eq("id", logbookId)
    .eq("user_id", userId)
    .single();

  if (!logbook) {
    throw new Error("Logbook tidak ditemukan.");
  }

  // Get all photos with google_file_id for Drive cleanup
  const { data: activities } = await supabaseAdmin
    .from("activities")
    .select("id")
    .eq("logbook_id", logbookId);

  const activityIds = activities?.map((a) => a.id) || [];

  let photoFileIds: string[] = [];
  if (activityIds.length > 0 && driveAccessToken) {
    const CHUNK_SIZE = 40;
    for (let i = 0; i < activityIds.length; i += CHUNK_SIZE) {
      const chunk = activityIds.slice(i, i + CHUNK_SIZE);
      const { data: photos } = await supabaseAdmin
        .from("photos")
        .select("google_file_id")
        .in("activity_id", chunk)
        .not("google_file_id", "is", null);

      if (photos) {
        photoFileIds.push(...(photos.map((p) => p.google_file_id).filter(Boolean) as string[]));
      }
    }
  }

  // ── Step 1: Delete all Drive files (best effort, non-blocking) ──
  if (driveAccessToken) {
    for (const fileId of photoFileIds) {
      try {
        await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${driveAccessToken}` },
        });
      } catch {
        // Best effort — proceed with DB cleanup regardless
      }
    }
  }

  // ── Step 2: Delete photos from DB ──
  if (activityIds.length > 0) {
    const CHUNK_SIZE = 40;
    for (let i = 0; i < activityIds.length; i += CHUNK_SIZE) {
      const chunk = activityIds.slice(i, i + CHUNK_SIZE);
      await supabaseAdmin.from("photos").delete().in("activity_id", chunk);
    }
  }

  // ── Step 3: Delete activities ──
  await supabaseAdmin.from("activities").delete().eq("logbook_id", logbookId);

  // ── Step 4: Delete logbook ──
  const { error } = await supabaseAdmin
    .from("logbooks")
    .delete()
    .eq("id", logbookId)
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Gagal menghapus logbook: ${error.message}`);
  }
}

export interface LogbookDetail extends LogbookWithStats {
  filled_days: number;
  total_date_range_days: number;
}

/**
 * OPTIMIZED: No longer calls getUserLogbooksWithStats (which processes ALL logbooks).
 * Uses direct batch queries instead.
 */
export async function getLogbookDetail(
  logbookId: string,
  userId: string
): Promise<LogbookDetail | null> {
  // Query 1: Get the single logbook directly
  const { data: logbook, error } = await supabaseAdmin
    .from("logbooks")
    .select("*")
    .eq("id", logbookId)
    .eq("user_id", userId)
    .single();

  if (error || !logbook) return null;

  // Query 2: Get activities for this logbook
  const { data: activities } = await supabaseAdmin
    .from("activities")
    .select("id, activity_date")
    .eq("logbook_id", logbookId);

  const activityList = (activities || []) as Array<{ id: string; activity_date: string }>;
  const totalActivities = activityList.length;
  const uniqueDates = new Set(activityList.map((a) => a.activity_date));
  const totalHari = uniqueDates.size;
  const activityDateStrings = Array.from(uniqueDates);

  // Query 3: Get photo count
  const activityIds = activityList.map((a) => a.id);
  let totalPhotos = 0;
  if (activityIds.length > 0) {
    const CHUNK_SIZE = 40;
    for (let i = 0; i < activityIds.length; i += CHUNK_SIZE) {
      const chunk = activityIds.slice(i, i + CHUNK_SIZE);
      const { count } = await supabaseAdmin
        .from("photos")
        .select("*", { count: "exact", head: true })
        .in("activity_id", chunk);
      if (count) totalPhotos += count;
    }
  }

  // Resolve date range
  const [startDate, endDate] = resolveDateRange(
    logbook.start_date,
    logbook.end_date,
    activityDateStrings
  );

  // Calculate progress
  let progressPercent = 0;
  if (startDate && endDate) {
    progressPercent = calculateHybridProgress(startDate, endDate, totalHari);
  }

  // Calculate activity count by date
  const activityCountByDate: Record<string, number> = {};
  for (const a of activityList) {
    activityCountByDate[a.activity_date] = (activityCountByDate[a.activity_date] || 0) + 1;
  }

  // Calculate remaining days
  let remainingHari = 0;
  if (startDate && endDate) {
    const end = new Date(endDate + "T00:00:00Z").getTime();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const now = today.getTime();
    remainingHari = Math.max(0, Math.round((end - now) / 86400000));
  }

  // Calculate total days in date range
  let totalDateRangeHari = 0;
  if (startDate && endDate) {
    const start = new Date(startDate + "T00:00:00Z").getTime();
    const end = new Date(endDate + "T00:00:00Z").getTime();
    totalDateRangeHari = Math.max(1, Math.round((end - start) / 86400000) + 1);
  } else if (uniqueDates.size > 0) {
    const sortedDates = Array.from(uniqueDates).sort();
    const start = new Date(sortedDates[0] + "T00:00:00Z").getTime();
    const end = new Date(sortedDates[sortedDates.length - 1] + "T00:00:00Z").getTime();
    totalDateRangeHari = Math.max(1, Math.round((end - start) / 86400000) + 1);
  }

  const l = logbook as any;
  return {
    ...logbook,
    total_days: totalHari,
    total_activities: totalActivities,
    total_photos: totalPhotos,
    progress_percent: Math.min(100, progressPercent),
    start_date: startDate,
    end_date: endDate,
    activity_count_by_date: activityCountByDate,
    status: l.status || undefined,
    location: l.location || undefined,
    institution_name: l.institution_name || undefined,
    supervisor_name: l.supervisor_name || undefined,
    mentor_name: l.mentor_name || undefined,
    remaining_days: remainingHari,
    filled_days: uniqueDates.size,
    total_date_range_days: totalDateRangeHari,
  };
}

export async function getLogbookById(
  logbookId: string,
  userId: string
): Promise<Logbook | null> {
  const { data, error } = await supabaseAdmin
    .from("logbooks")
    .select("*")
    .eq("id", logbookId)
    .eq("user_id", userId)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      return null;
    }
    throw new Error(`Gagal mengambil detail logbook: ${error.message}`);
  }

  return data as Logbook;
}

/**
 * Updates a logbook (title, description, type).
 * Only the owner can update.
 */
export async function updateLogbook(
  logbookId: string,
  userId: string,
  input: UpdateLogbookInput
): Promise<Logbook> {
  const updateData: Record<string, unknown> = {};
  if (input.title !== undefined) updateData.title = input.title;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.type !== undefined) updateData.type = input.type;
  if (input.status !== undefined) updateData.status = input.status;
  if (input.location !== undefined) updateData.location = input.location;
  if (input.institution_name !== undefined) updateData.institution_name = input.institution_name;
  if (input.supervisor_name !== undefined) updateData.supervisor_name = input.supervisor_name;
  if (input.mentor_name !== undefined) updateData.mentor_name = input.mentor_name;
  if (input.start_date !== undefined) updateData.start_date = input.start_date;
  if (input.end_date !== undefined) updateData.end_date = input.end_date;
  updateData.updated_at = new Date().toISOString();

  if (Object.keys(updateData).length === 0) {
    throw new Error("Tidak ada data yang diubah.");
  }

  const { data, error } = await supabaseAdmin
    .from("logbooks")
    .update(updateData)
    .eq("id", logbookId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      throw new Error("Logbook tidak ditemukan.");
    }
    throw new Error(`Gagal mengupdate logbook: ${error.message}`);
  }

  return data as Logbook;
}