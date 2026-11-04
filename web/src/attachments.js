// Composer attachments: any file, at most 16 per message, 25MiB each and 64MiB in total (the server enforces the same).
// Images the models read as pixels go as `images`; everything else goes as `files`.
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];
export const ATTACHMENTS_MAX = 16, ATTACHMENT_BYTES = 25 << 20, ATTACHMENTS_BYTES = 64 << 20;

/** Reads picked files into composer items `{ name, size, mime, data }` (base64), after checking the limits against `current`. */
export async function readAttachments(picked, current = []) {
  const incoming = [...picked];
  if (current.length + incoming.length > ATTACHMENTS_MAX) throw Error(`每条消息最多 ${ATTACHMENTS_MAX} 个附件`);
  if (incoming.some((file) => file.size > ATTACHMENT_BYTES)) throw Error("单个附件不能超过 25MiB");
  if ([...current, ...incoming].reduce((sum, file) => sum + file.size, 0) > ATTACHMENTS_BYTES) throw Error("附件总大小不能超过 64MiB");
  return Promise.all(incoming.map((file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, size: file.size, mime: file.type || "application/octet-stream", data: String(reader.result).split(",")[1] || "" });
    reader.onerror = () => reject(Error("读取附件失败：" + file.name));
    reader.readAsDataURL(file);
  })));
}

export const isImage = (item) => IMAGE_MIMES.includes(item.mime);

/** The message body fields for composer items (a file's size is only shown on the unsent copy; the server measures it). */
export function attachmentPayload(items = []) {
  return {
    images: items.filter(isImage).map(({ mime, data }) => ({ mime, data })),
    files: items.filter((item) => !isImage(item)).map(({ name, size, mime, data }) => ({ name, size, mime, data })),
  };
}

export function formatSize(bytes = 0) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1 << 20 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1 << 20)).toFixed(1)} MB`;
}

/** Download link of a stored file; the server sends non-image types as an attachment with this name. */
export const fileUrl = (file) => `/api/blobs/${encodeURIComponent(file.blobId)}?name=${encodeURIComponent(file.name || "file")}`;
