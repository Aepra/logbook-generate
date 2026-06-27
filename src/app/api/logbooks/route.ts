import { getServerSession } from "next-auth/next";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { createLogbook, getUserLogbooks } from "@/services/logbook.service";
import { getUserIdByEmail } from "@/lib/user";
import { supabaseAdmin } from "@/lib/supabase-server";

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const userId = await getUserIdByEmail(session.user.email);

    if (!userId) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const logbooks = await getUserLogbooks(userId);
    return NextResponse.json({ logbooks });
  } catch (error) {
    console.error("GET /api/logbooks error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { title, description, type, start_date, end_date } = body;

    // Validasi input
    if (!title || !title.trim()) {
      return NextResponse.json(
        { error: "Judul wajib diisi" },
        { status: 400 }
      );
    }

    const userId = await getUserIdByEmail(session.user.email);

    if (!userId) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const logbook = await createLogbook(
      userId,
      {
        title: title.trim(),
        description: description?.trim() || "",
        type: type || "other",
        start_date: start_date || undefined,
        end_date: end_date || undefined,
      }
    );

    console.log("[API Logbook] Created logbook:", {
      id: logbook.id,
      title: logbook.title,
      start_date: logbook.start_date,
      end_date: logbook.end_date,
    });

    return NextResponse.json({ logbook }, { status: 201 });
  } catch (error) {
    console.error("POST /api/logbooks error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}