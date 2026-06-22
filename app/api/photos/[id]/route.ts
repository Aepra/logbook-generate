import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { deletePhoto } from "@/services/photo.service";
import { getUserIdByEmail } from "@/lib/user";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const userId = await getUserIdByEmail(session.user.email);

    if (!userId) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const result = await deletePhoto(id, userId);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Gagal menghapus foto" },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[DELETE PHOTO]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}