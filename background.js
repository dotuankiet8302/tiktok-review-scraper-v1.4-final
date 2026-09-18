const IMAGE_HOST_PATTERN = /(^|\.)((i)?byteimg\.com|ibyteimg\.com|tiktokcdn(?:-[a-z0-9]+)?\.com)$/i;

function extensionFromUrl(url) {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "jpg";
  if (clean.endsWith(".webp")) return "webp";
  if (clean.endsWith(".avif")) return "avif";
  return "webp";
}

function sanitizeFolderName(value) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  const words = cleaned.split(" ").filter(Boolean).slice(0, 8);
  return words.join(" ").slice(0, 60).trim() || "TikTok Product";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function crc32(bytes) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crc32.table[i] = value >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crc32.table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function writeHeader(signature, size) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  return { bytes, view };
}

function createZipBlob(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const centralParts = [];
  const { time, date } = dosDateTime();
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name.replace(/\\/g, "/"));
    const data = entry.data;
    const crc = crc32(data);

    const local = writeHeader(0x04034b50, 30 + name.length);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(8, 0, true);
    local.view.setUint16(10, time, true);
    local.view.setUint16(12, date, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, name.length, true);
    local.bytes.set(name, 30);
    parts.push(local.bytes, data);

    const central = writeHeader(0x02014b50, 46 + name.length);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0x0800, true);
    central.view.setUint16(10, 0, true);
    central.view.setUint16(12, time, true);
    central.view.setUint16(14, date, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, data.length, true);
    central.view.setUint32(24, data.length, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(42, offset, true);
    central.bytes.set(name, 46);
    centralParts.push(central.bytes);

    offset += local.bytes.length + data.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const part of centralParts) centralSize += part.length;

  const end = writeHeader(0x06054b50, 22);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, centralOffset, true);

  return new Blob([...parts, ...centralParts, end.bytes], { type: "application/zip" });
}

function sanitizeZipEntryName(value) {
  return String(value || "")
    .replace(/[<>:"\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^-+|-+$/g, "")
    .trim() || "image";
}

function extensionFromContentType(value) {
  const type = String(value || "").split(";")[0].trim().toLowerCase();
  if (type === "image/png") return "png";
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/avif") return "avif";
  if (type === "image/gif") return "gif";
  return "";
}

async function fetchImageWithRetry(url, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        // Ảnh bản gốc có URL kết thúc bằng ".image" nên không đoán được đuôi;
        // lấy theo Content-Type thật để file mở đúng.
        ext: extensionFromContentType(response.headers.get("content-type"))
      };
    } catch (error) {
      lastError = error;
      await sleep(350 * attempt);
    }
  }
  throw lastError;
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:application/zip;base64,${btoa(binary)}`;
}

async function downloadBlob(blob, filename) {
  const url = typeof URL.createObjectURL === "function"
    ? URL.createObjectURL(blob)
    : await blobToDataUrl(blob);

  try {
    return await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
  } finally {
    if (url.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
}

function isAllowedImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && IMAGE_HOST_PATTERN.test(url.hostname);
  } catch {
    return false;
  }
}

async function updateProgress(progress) {
  await chrome.storage.local.set({ downloadProgress: progress });
  try {
    await chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", progress });
  } catch {
    // Popup có thể đang đóng.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "DOWNLOAD_IMAGES") return undefined;

  (async () => {
    const images = Array.isArray(message.images) ? message.images : [];
    const folderName = sanitizeFolderName(message.folderName);
    const uniqueImages = [];
    const seen = new Set();

    for (const item of images) {
      const url = String(item?.url || "");
      if (!isAllowedImageUrl(url) || seen.has(url)) continue;
      seen.add(url);
      uniqueImages.push(item);
    }

    let success = 0;
    let failed = 0;
    const total = uniqueImages.length;

    await updateProgress({
      current: 0,
      total,
      success,
      failed,
      folderName,
      finished: total === 0
    });

    const zipEntries = [];

    for (let i = 0; i < uniqueImages.length; i += 1) {
      const item = uniqueImages[i];
      const reviewNumber = String(item.reviewIndex || i + 1).padStart(3, "0");
      const imageNumber = String(item.imageIndex || 1).padStart(2, "0");

      try {
        const { data, ext } = await fetchImageWithRetry(item.url);
        const filename = `Images/review-${reviewNumber}-${imageNumber}.${ext || extensionFromUrl(item.url)}`;
        zipEntries.push({ name: sanitizeZipEntryName(filename), data });
        success += 1;
      } catch (error) {
        failed += 1;
        console.warn("Không thể tải ảnh:", item.url, error);
      }

      await updateProgress({
        current: i + 1,
        total,
        success,
        failed,
        folderName,
        finished: i + 1 === total
      });

      await sleep(140);
    }

    if (zipEntries.length) {
      await updateProgress({
        current: total,
        total,
        success,
        failed,
        folderName,
        finished: false,
        zipping: true
      });

      const zipBlob = createZipBlob(zipEntries);
      await downloadBlob(zipBlob, `${folderName}/Images.zip`);
    }

    await updateProgress({
      current: total,
      total,
      success,
      failed,
      folderName,
      finished: true
    });

    sendResponse({ ok: true, success, failed, skipped: images.length - total, folderName });
  })();

  return true;
});
