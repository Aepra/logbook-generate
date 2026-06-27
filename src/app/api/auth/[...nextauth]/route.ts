import NextAuth, { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { createClient } from "@supabase/supabase-js";
import { getOrCreateUserRootFolder } from "@/services/google-drive.service";
import { createTraceContext } from "@/types/drive";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

import { refreshAccessToken } from "@/lib/token-refresh";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      authorization: {
        params: {
          prompt: "consent",
          access_type: "offline",
          response_type: "code",
          scope: "openid email profile",
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider === "google") {
        console.log("Mengecek user di Supabase untuk:", user.email);

        try {
          // 1. Cek apakah user sudah ada di database
          const { data: existingUser, error: checkError } = await supabase
            .from("users")
            .select("id, drive_folder_id")
            .eq("email", user.email)
            .single();

          if (checkError && checkError.code !== "PGRST116") {
            console.error("Error cek user:", checkError);
            return false;
          }

          // 2. Create or verify Drive root folder exists
          // This is idempotent — if folder exists, returns existing ID
          const userEmail = user.email || "";

          // Call Drive service to get or create user root folder (now uses Service Account internally)
          const trace = createTraceContext(`signin_${userEmail}`);
          const driveFolderId = await getOrCreateUserRootFolder(trace, userEmail);

          // 3. Handle user record in database
          if (!existingUser) {
            // NEW USER: Insert with drive folder ID
            const { error: insertError } = await supabase
              .from("users")
              .insert({
                google_id: user.id,
                name: user.name,
                email: user.email,
                avatar: user.image,
                drive_folder_id: driveFolderId,
              });

            if (insertError) {
              console.error(
                "Gagal menyimpan user ke Supabase:",
                insertError
              );
              return false;
            }

            console.log(
              "✅ User baru terdaftar dengan Drive folder ID:",
              driveFolderId
            );
          } else {
            // EXISTING USER: Update drive_folder_id if missing or changed
            if (
              driveFolderId &&
              existingUser.drive_folder_id !== driveFolderId
            ) {
              const { error: updateError } = await supabase
                .from("users")
                .update({ drive_folder_id: driveFolderId })
                .eq("id", existingUser.id);

              if (updateError) {
                console.error(
                  "Gagal update drive_folder_id:",
                  updateError
                );
              } else {
                console.log(
                  "✅ Drive folder ID diperbarui untuk user:",
                  user.email
                );
              }
            } else {
              console.log("User sudah terdaftar di database.");
            }
          }

          return true;
        } catch (error) {
          console.error("Terjadi kesalahan sistem:", error);
          return false;
        }
      }
      return false;
    },
    async jwt({ token }) {
      return token;
    },
    async session({ session }) {
      return session;
    },
  },
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };