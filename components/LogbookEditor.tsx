"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { PhotoRecord } from "@/services/photo.service";
import type { Logbook } from "@/services/logbook.service";
import type { ActivitiesByDate, Activity } from "@/services/activity.service";

// ──────────────────────────────────────────
// Inline Editable Text Component
// ──────────────────────────────────────────
function EditableText({
  value,
  onSave,
  placeholder = "",
  className = "",
  tag,
  multiline = false,
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  className?: string;
  tag?: "h1" | "h2" | "h3" | "h4" | "p" | "span" | "div";
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (typeof (inputRef.current as HTMLInputElement).setSelectionRange === "function") {
        (inputRef.current as HTMLInputElement).setSelectionRange(draft.length, draft.length);
      }
    }
  }, [editing, draft.length]);

  const commit = useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value && trimmed) {
      onSave(trimmed);
    } else {
      setDraft(value);
    }
  }, [draft, value, onSave]);

  if (editing && multiline) {
    return (
      <textarea
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
        className={`w-full bg-[#f9f7f0] border-b-2 border-[#d4a373] outline-none resize-none font-serif ${className}`}
        rows={3}
        placeholder={placeholder}
      />
    );
  }

  if (editing) {
    return (
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className={`w-full bg-[#f9f7f0] border-b-2 border-[#d4a373] outline-none font-serif ${className}`}
        placeholder={placeholder}
      />
    );
  }

  const TagName = tag || "div";
  const Element = TagName as unknown as React.ElementType;
  return (
    <Element
      onClick={() => setEditing(true)}
      className={`cursor-pointer hover:bg-[#f9f7f0]/60 rounded px-0.5 -ml-0.5 transition-colors group relative ${className}`}
      title="Klik untuk edit"
    >
      {value || <span className="text-[#b8a97c] italic">{placeholder}</span>}
      <span className="absolute -right-5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-40 text-[#b8a97c] text-xs">✎</span>
    </Element>
  );
}

// ──────────────────────────────────────────
// Photo Thumbnail with Delete
// ──────────────────────────────────────────
function PhotoThumbnail({
  photo,
  onPreview,
  onDelete,
}: {
  photo: PhotoRecord;
  onPreview: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="relative group">
      <button
        onClick={onPreview}
        className="w-16 h-16 rounded overflow-hidden border border-[#d4a373]/30 hover:border-[#d4a373] transition shadow-sm"
      >
        <img
          src={`/api/photos/proxy?fileId=${photo.google_file_id}`}
          alt=""
          className="w-full h-full object-cover"
          loading="lazy"
        />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition hover:bg-red-600 shadow"
        title="Hapus foto"
      >
        ×
      </button>
    </div>
  );
}

// ──────────────────────────────────────────
// Activity Card — Editable
// ──────────────────────────────────────────
function ActivityCard({
  activity,
  photos,
  isUploading,
  onUpdate,
  onPhotoUpload,
  onPhotoDelete,
  onPreviewPhoto,
}: {
  activity: Activity;
  photos: PhotoRecord[];
  isUploading: boolean;
  onUpdate: (data: Partial<{
    activity_date: string;
    start_time: string | null;
    end_time: string | null;
    title: string;
    description: string;
    obstacle: string;
  }>) => Promise<void>;
  onPhotoUpload: (file: File) => void;
  onPhotoDelete: (photoId: string) => void;
  onPreviewPhoto: (url: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const formatTimeDisplay = (t: string | null) => t || "—";
  const calcDuration = (s: string | null, e: string | null) => {
    if (!s || !e) return "";
    const [sh, sm] = s.split(":").map(Number);
    const [eh, em] = e.split(":").map(Number);
    if (isNaN(sh) || isNaN(sm) || isNaN(eh) || isNaN(em)) return "";
    const diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff <= 0) return "";
    return `${Math.floor(diff / 60)}j ${diff % 60}m`;
  };

  return (
    <div className="border-l-2 border-[#d4a373]/40 pl-4 py-1 mb-3 hover:border-[#d4a373] transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <EditableText
            value={activity.title}
            onSave={(v) => onUpdate({ title: v })}
            tag="h4"
            className="text-base font-semibold text-[#2c2c2c] leading-snug"
            placeholder="Judul aktivitas..."
          />
          <div className="flex items-center gap-3 mt-1 text-xs text-[#8a7a5a]">
            <span className="font-mono">
              {formatTimeDisplay(activity.start_time)}
              {activity.start_time && activity.end_time ? " – " : ""}
              {formatTimeDisplay(activity.end_time)}
            </span>
            {calcDuration(activity.start_time, activity.end_time) && (
              <span className="text-[#b8a97c]">
                · {calcDuration(activity.start_time, activity.end_time)}
              </span>
            )}
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="text-[#b8a97c] hover:text-[#8a7a5a] transition"
            >
              {collapsed ? "▸" : "▾"}
            </button>
          </div>
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="mt-2">
            <EditableText
              value={activity.description}
              onSave={(v) => onUpdate({ description: v })}
              tag="p"
              multiline
              className="text-sm text-[#5a4a3a] leading-relaxed"
              placeholder="Deskripsi kegiatan..."
            />
          </div>

          {activity.obstacle && (
            <div className="mt-1">
              <span className="text-xs text-[#b8a97c] font-medium">Kendala: </span>
              <EditableText
                value={activity.obstacle}
                onSave={(v) => onUpdate({ obstacle: v })}
                tag="span"
                className="text-sm text-[#8a7a5a] italic"
                placeholder="Tidak ada kendala"
              />
            </div>
          )}

          {photos.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {photos.map((photo) => (
                <PhotoThumbnail
                  key={photo.id}
                  photo={photo}
                  onPreview={() => onPreviewPhoto(photo.google_drive_url)}
                  onDelete={() => onPhotoDelete(photo.id)}
                />
              ))}
            </div>
          )}

          <div className="mt-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onPhotoUpload(file);
                if (e.target) e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="text-xs text-[#b8a97c] hover:text-[#8a7a5a] transition disabled:opacity-50 flex items-center gap-1"
            >
              {isUploading ? (
                <span className="animate-pulse">Mengupload…</span>
              ) : (
                <>
                  <span className="text-base leading-none">+</span> Tambah foto
                </>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────
// Props
// ──────────────────────────────────────────
interface Props {
  logbook: Logbook;
  logbookId: string;
  initialGroupedActivities: ActivitiesByDate[];
  initialPhotosByActivity: Record<string, PhotoRecord[]>;
}

// ──────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────
export default function LogbookEditor({
  logbook: initialLogbook,
  logbookId,
  initialGroupedActivities,
  initialPhotosByActivity,
}: Props) {
  const router = useRouter();

  const [logbook, setLogbook] = useState(initialLogbook);
  const [groupedActivities, setGroupedActivities] = useState(initialGroupedActivities);
  const [photosByActivity, setPhotosByActivity] = useState(initialPhotosByActivity);
  const [uploadingActivityId, setUploadingActivityId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());

  useEffect(() => {
    setExpandedDates(new Set(groupedActivities.map((g) => g.date)));
  }, [groupedActivities]);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const updateLogbookField = useCallback(async (fields: Partial<{ title: string; description: string; type: string }>) => {
    try {
      const res = await fetch(`/api/logbooks/${logbookId}/update`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menyimpan");
      setLogbook((prev) => ({ ...prev, ...data.logbook }));
      showToast("success", "Tersimpan");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Gagal menyimpan");
    }
  }, [logbookId, showToast]);

  const updateActivityField = useCallback(async (
    activityId: string,
    fields: Partial<{
      activity_date: string;
      start_time: string | null;
      end_time: string | null;
      title: string;
      description: string;
      obstacle: string;
    }>
  ) => {
    try {
      const res = await fetch(`/api/activities/${activityId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menyimpan aktivitas");
      setGroupedActivities((prev) =>
        prev.map((g) => ({
          ...g,
          activities: g.activities.map((a) =>
            a.id === activityId ? { ...a, ...data.activity } : a
          ),
        }))
      );
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Gagal menyimpan");
    }
  }, [showToast]);

  const handlePhotoUpload = useCallback(async (activityId: string, file: File) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      showToast("error", "Hanya JPEG, PNG, dan WebP yang diperbolehkan.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast("error", "Ukuran file maksimal 5MB.");
      return;
    }
    setUploadingActivityId(activityId);
    try {
      const formData = new FormData();
      formData.append("activity_id", activityId);
      formData.append("file", file);
      const res = await fetch("/api/photos/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || "Upload gagal");
      if (data.photo) {
        setPhotosByActivity((prev) => ({
          ...prev,
          [activityId]: [...(prev[activityId] || []), data.photo as PhotoRecord],
        }));
      }
      showToast("success", "Foto berhasil diupload");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Upload gagal");
    } finally {
      setUploadingActivityId(null);
    }
  }, [showToast]);

  const handlePhotoDelete = useCallback(async (photoId: string, activityId: string) => {
    if (!confirm("Hapus foto ini?")) return;
    try {
      const res = await fetch(`/api/photos/${photoId}`, { method: "DELETE" });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Gagal menghapus foto"); }
      setPhotosByActivity((prev) => ({
        ...prev,
        [activityId]: (prev[activityId] || []).filter((p) => p.id !== photoId),
      }));
      showToast("success", "Foto dihapus");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Gagal menghapus");
    }
  }, [showToast]);

  const expandAll = () => setExpandedDates(new Set(groupedActivities.map((g) => g.date)));
  const collapseAll = () => setExpandedDates(new Set());

  const formatDateHeading = (dateStr: string) =>
    new Date(dateStr + "T00:00:00").toLocaleDateString("id-ID", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });

  const [showNewActivityModal, setShowNewActivityModal] = useState(false);
  const [newActivityForm, setNewActivityForm] = useState({
    activity_date: new Date().toISOString().split("T")[0],
    start_time: "",
    end_time: "",
    title: "",
    description: "",
    obstacle: "",
  });
  const [newActivityError, setNewActivityError] = useState("");

  const handleCreateActivity = async (e: React.FormEvent) => {
    e.preventDefault();
    setNewActivityError("");
    try {
      const res = await fetch("/api/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newActivityForm, logbook_id: logbookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal membuat aktivitas");
      setNewActivityForm({
        activity_date: new Date().toISOString().split("T")[0],
        start_time: "", end_time: "", title: "", description: "", obstacle: "",
      });
      setShowNewActivityModal(false);
      router.refresh();
    } catch (err) {
      setNewActivityError(err instanceof Error ? err.message : "Gagal membuat aktivitas");
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f0e8] font-serif">
      {toast && (
        <div className="fixed top-6 right-6 z-50">
          <div className={`px-5 py-3 rounded-lg shadow-lg text-sm font-medium ${
            toast.type === "success"
              ? "bg-[#2c2c2c] text-[#f5f0e8] border border-[#d4a373]/30"
              : "bg-red-600 text-white"
          }`}>
            {toast.message}
          </div>
        </div>
      )}

      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Book cover header */}
        <div className="bg-[#2c2c2c] rounded-t-lg px-8 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[#d4a373] text-lg">📖</span>
            <span className="text-[#b8a97c] text-xs uppercase tracking-widest font-sans">LogBook</span>
          </div>
          <button
            onClick={() => router.push("/")}
            className="text-[#8a7a5a] hover:text-[#b8a97c] transition text-xs font-sans uppercase tracking-wider"
          >
            ← Kembali
          </button>
        </div>

        {/* Pages container */}
        <div className="bg-[#faf8f2] border-l border-r border-[#d4a373]/20 shadow-xl px-8 sm:px-12 py-10 min-h-[70vh]">
          {/* LOGBOOK HEADER */}
          <div className="mb-10 pb-6 border-b border-[#d4a373]/20">
            <EditableText
              value={logbook.title}
              onSave={(v) => updateLogbookField({ title: v })}
              tag="h1"
              className="text-3xl font-bold text-[#2c2c2c] leading-tight"
              placeholder="Judul Logbook..."
            />
            <div className="mt-3">
              <EditableText
                value={logbook.description}
                onSave={(v) => updateLogbookField({ description: v })}
                tag="p"
                multiline
                className="text-base text-[#6b5b4b] leading-relaxed"
                placeholder="Deskripsi logbook..."
              />
            </div>
            <div className="flex items-center gap-4 mt-4 text-xs text-[#8a7a5a]">
              <span>
                {new Date(logbook.created_at).toLocaleDateString("id-ID", {
                  day: "numeric", month: "long", year: "numeric",
                })}
              </span>
              <span className="text-[#d4a373]/40">|</span>
              <span className="uppercase tracking-wider">{logbook.type}</span>
            </div>
          </div>

          {/* ACTIVITIES */}
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[#2c2c2c]">Kegiatan</h2>
              <div className="flex items-center gap-2">
                <button onClick={expandAll} className="text-xs text-[#8a7a5a] hover:text-[#2c2c2c] transition font-sans">Buka semua</button>
                <span className="text-[#d4a373]/40">·</span>
                <button onClick={collapseAll} className="text-xs text-[#8a7a5a] hover:text-[#2c2c2c] transition font-sans">Tutup semua</button>
                <span className="text-[#d4a373]/40">·</span>
                <button onClick={() => setShowNewActivityModal(true)} className="text-sm text-[#d4a373] hover:text-[#b8895c] transition font-sans font-semibold">+ Baru</button>
              </div>
            </div>

            {groupedActivities.length === 0 && (
              <div className="text-center py-16">
                <div className="text-4xl mb-4">📝</div>
                <p className="text-[#8a7a5a] italic">Belum ada kegiatan yang dicatat.</p>
                <button onClick={() => setShowNewActivityModal(true)} className="mt-4 text-sm text-[#d4a373] hover:text-[#b8895c] transition font-sans">+ Catat kegiatan pertama</button>
              </div>
            )}

            {groupedActivities.map((group) => {
              const isExpanded = expandedDates.has(group.date);
              const totalActivities = group.activities.length;
              const totalDuration = group.totalTimeMinutes;
              return (
                <div key={group.date} className="border-b border-[#d4a373]/10 pb-4 last:border-b-0">
                  <button
                    onClick={() => setExpandedDates((prev) => { const n = new Set(prev); n.has(group.date) ? n.delete(group.date) : n.add(group.date); return n; })}
                    className="w-full text-left group mb-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[#b8a97c] font-sans uppercase tracking-wider">{formatDateHeading(group.date)}</span>
                      <span className="text-xs text-[#b8a97c]/60 font-sans">· {totalActivities} kegiatan{totalDuration > 0 && ` · ${Math.floor(totalDuration / 60)}j ${totalDuration % 60}m`}</span>
                      <span className="ml-auto text-[#d4a373]/40 group-hover:text-[#d4a373] transition text-xs">{isExpanded ? "▲" : "▼"}</span>
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="ml-2">
                      {group.activities.map((activity) => (
                        <ActivityCard
                          key={activity.id}
                          activity={activity}
                          photos={photosByActivity[activity.id] || []}
                          isUploading={uploadingActivityId === activity.id}
                          onUpdate={(fields) => updateActivityField(activity.id, fields)}
                          onPhotoUpload={(file) => handlePhotoUpload(activity.id, file)}
                          onPhotoDelete={(photoId) => handlePhotoDelete(photoId, activity.id)}
                          onPreviewPhoto={(url) => setPreviewUrl(url)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Book bottom shadow */}
        <div className="bg-[#2c2c2c] rounded-b-lg h-3" />
      </div>

      {/* Image Preview Modal */}
      {previewUrl && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 cursor-pointer" onClick={() => setPreviewUrl(null)}>
          <div className="max-w-2xl max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setPreviewUrl(null)} className="float-right mb-2 text-white text-xl hover:text-gray-300">&times;</button>
            <img
              src={`/api/photos/proxy?fileId=${previewUrl.split("/d/")[1]?.split("/")[0] || ""}`}
              alt="Preview"
              className="max-w-full max-h-[85vh] rounded-lg shadow-xl"
            />
          </div>
        </div>
      )}

      {/* New Activity Modal */}
      {showNewActivityModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-[#faf8f2] rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto border border-[#d4a373]/20">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-semibold text-[#2c2c2c]">Kegiatan Baru</h3>
              <button onClick={() => { setShowNewActivityModal(false); setNewActivityError(""); }} className="text-[#8a7a5a] hover:text-[#2c2c2c] text-xl leading-none transition">&times;</button>
            </div>
            {newActivityError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-md mb-4 text-sm">{newActivityError}</div>
            )}
            <form onSubmit={handleCreateActivity} className="space-y-4">
              <div>
                <label className="block text-xs font-sans text-[#8a7a5a] uppercase tracking-wider mb-1">Tanggal</label>
                <input type="date" value={newActivityForm.activity_date} onChange={(e) => setNewActivityForm((f) => ({ ...f, activity_date: e.target.value }))} className="w-full border border-[#d4a373]/30 rounded px-3 py-2 text-sm bg-[#f9f7f0] focus:outline-none focus:border-[#d4a373] font-serif" required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-sans text-[#8a7a5a] uppercase tracking-wider mb-1">Jam Mulai</label>
                  <input type="time" value={newActivityForm.start_time} onChange={(e) => setNewActivityForm((f) => ({ ...f, start_time: e.target.value }))} className="w-full border border-[#d4a373]/30 rounded px-3 py-2 text-sm bg-[#f9f7f0] focus:outline-none focus:border-[#d4a373] font-serif" />
                </div>
                <div>
                  <label className="block text-xs font-sans text-[#8a7a5a] uppercase tracking-wider mb-1">Jam Selesai</label>
                  <input type="time" value={newActivityForm.end_time} onChange={(e) => setNewActivityForm((f) => ({ ...f, end_time: e.target.value }))} className="w-full border border-[#d4a373]/30 rounded px-3 py-2 text-sm bg-[#f9f7f0] focus:outline-none focus:border-[#d4a373] font-serif" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-sans text-[#8a7a5a] uppercase tracking-wider mb-1">Judul</label>
                <input type="text" value={newActivityForm.title} onChange={(e) => setNewActivityForm((f) => ({ ...f, title: e.target.value }))} className="w-full border border-[#d4a373]/30 rounded px-3 py-2 text-sm bg-[#f9f7f0] focus:outline-none focus:border-[#d4a373] font-serif" required placeholder="Contoh: Membuat halaman login" />
              </div>
              <div>
                <label className="block text-xs font-sans text-[#8a7a5a] uppercase tracking-wider mb-1">Deskripsi</label>
                <textarea value={newActivityForm.description} onChange={(e) => setNewActivityForm((f) => ({ ...f, description: e.target.value }))} rows={3} className="w-full border border-[#d4a373]/30 rounded px-3 py-2 text-sm bg-[#f9f7f0] focus:outline-none focus:border-[#d4a373] font-serif" placeholder="Deskripsi detail kegiatan" />
              </div>
              <div>
                <label className="block text-xs font-sans text-[#8a7a5a] uppercase tracking-wider mb-1">Kendala</label>
                <textarea value={newActivityForm.obstacle} onChange={(e) => setNewActivityForm((f) => ({ ...f, obstacle: e.target.value }))} rows={2} className="w-full border border-[#d4a373]/30 rounded px-3 py-2 text-sm bg-[#f9f7f0] focus:outline-none focus:border-[#d4a373] font-serif" placeholder="Kendala yang dihadapi (jika ada)" />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => { setShowNewActivityModal(false); setNewActivityError(""); }} className="px-4 py-2 text-sm text-[#8a7a5a] border border-[#d4a373]/30 rounded-md hover:bg-[#f9f7f0] transition font-sans">Batal</button>
                <button type="submit" className="px-4 py-2 text-sm text-white bg-[#2c2c2c] rounded-md hover:bg-[#1a1a1a] transition font-sans">Simpan</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Saving indicator */}
      <div className="fixed bottom-6 right-6 z-40">
        <span className="text-xs text-[#b8a97c] font-sans opacity-60">
          {logbook.title ? "Auto-save aktif" : ""}
        </span>
      </div>
    </div>
  );
}
