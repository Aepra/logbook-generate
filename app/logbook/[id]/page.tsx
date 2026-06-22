import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getUserIdByEmail } from "@/lib/user";
import { getLogbookById } from "@/services/logbook.service";
import { getActivitiesGroupedByDate } from "@/services/activity.service";
import { getPhotosByActivityIds } from "@/services/photo.service";
import type { PhotoRecord } from "@/services/photo.service";
import Link from "next/link";
import { notFound } from "next/navigation";
import LogbookEditor from "@/components/LogbookEditor";

export default async function LogbookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gray-900 text-white p-24">
        <h1 className="text-2xl font-bold mb-4">Silakan login terlebih dahulu</h1>
        <Link
          href="/api/auth/signin"
          className="bg-white text-black px-6 py-3 rounded-md font-semibold hover:bg-gray-200 transition"
        >
          Masuk dengan Google
        </Link>
      </main>
    );
  }

  const { id } = await params;

  const userId = session.user?.email
    ? await getUserIdByEmail(session.user.email)
    : null;

  if (!userId) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gray-50 text-gray-900 p-10">
        <p className="text-red-500">User tidak ditemukan.</p>
        <Link href="/" className="text-blue-600 hover:underline mt-4">
          Kembali ke Dashboard
        </Link>
      </main>
    );
  }

  const logbook = await getLogbookById(id, userId);

  if (!logbook) {
    notFound();
  }

  // Fetch grouped activities from service layer (grouping done here, not in UI)
  const groupedActivities = await getActivitiesGroupedByDate(id);

  // Fetch photos for all activities (batch query)
  const allActivityIds = groupedActivities.flatMap((g) =>
    g.activities.map((a) => a.id)
  );
  const photosMap = await getPhotosByActivityIds(allActivityIds);
  const initialPhotosByActivity: Record<string, PhotoRecord[]> = {};
  for (const [activityId, photos] of photosMap.entries()) {
    initialPhotosByActivity[activityId] = photos;
  }

  return (
    <LogbookEditor
      logbook={logbook}
      logbookId={id}
      initialGroupedActivities={groupedActivities}
      initialPhotosByActivity={initialPhotosByActivity}
    />
  );
}