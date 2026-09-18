const DEFAULT_STATE = {
  running: false,
  phase: "idle",
  message: "Chưa bắt đầu",
  detail: "Mở một trang sản phẩm TikTok Shop rồi nhấn \"Bắt đầu quét\".",
  round: 0,
  progress: 0,
  results: [],
  productName: "",
  sourceUrl: "",
  error: "",
  startedAt: null,
  finishedAt: null,
  options: {
    tryViewMore: true,
    autoScroll: true,
    deepImages: false,
    maxReviews: 50
  }
};

let currentState = DEFAULT_STATE;

const $ = (id) => document.getElementById(id);
const els = {
  statusBadge: $("statusBadge"),
  reviewCount: $("reviewCount"),
  imageCount: $("imageCount"),
  roundCount: $("roundCount"),
  phaseText: $("phaseText"),
  progressText: $("progressText"),
  progressBar: $("progressBar"),
  detailText: $("detailText"),
  downloadText: $("downloadText"),
  productName: $("productName"),
  maxReviews: $("maxReviews"),
  tryViewMore: $("tryViewMore"),
  autoScroll: $("autoScroll"),
  deepImages: $("deepImages"),
  startBtn: $("startBtn"),
  stopBtn: $("stopBtn"),
  docxBtn: $("docxBtn"),
  docBtn: $("docBtn"),
  csvBtn: $("csvBtn"),
  jsonBtn: $("jsonBtn"),
  imagesBtn: $("imagesBtn"),
  clearBtn: $("clearBtn"),
  searchInput: $("searchInput"),
  ratingFilter: $("ratingFilter"),
  hasImageFilter: $("hasImageFilter"),
  resultList: $("resultList")
};

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isTikTokShopUrl(url = "") {
  try {
    return new URL(url).hostname === "shop.tiktok.com";
  } catch {
    return false;
  }
}

function clampMaxReviews(value) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(5000, Math.max(1, Number.isFinite(parsed) ? parsed : 50));
}

function sanitizeFolderName(value) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  const words = cleaned.split(" ").filter(Boolean).slice(0, 8);
  const shortName = words.join(" ").slice(0, 60).trim();
  return shortName || "TikTok Product";
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab?.id || !isTikTokShopUrl(tab.url)) {
    throw new Error("Hãy mở một trang sản phẩm trên shop.tiktok.com.");
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

function imageCount(results) {
  return results.reduce((sum, item) => sum + (item.images?.length || 0), 0);
}

function withDefaults(rawState) {
  return {
    ...DEFAULT_STATE,
    ...(rawState || {}),
    options: { ...DEFAULT_STATE.options, ...(rawState?.options || {}) }
  };
}

function filteredResults(results) {
  const query = els.searchInput.value.trim().toLowerCase();
  const rating = els.ratingFilter.value;
  const hasImage = els.hasImageFilter.checked;

  return results.filter((review) => {
    if (rating !== "all" && Math.round(Number(review.rating || 0)) !== Number(rating)) return false;
    if (hasImage && !(review.images || []).length) return false;
    if (!query) return true;

    return [
      review.reviewerName,
      review.comment,
      review.date,
      review.productVariant,
      review.rating
    ].some((value) => String(value || "").toLowerCase().includes(query));
  });
}

function renderState(rawState) {
  currentState = withDefaults(rawState);
  const results = Array.isArray(currentState.results) ? currentState.results : [];
  const countImages = imageCount(results);

  els.reviewCount.textContent = String(results.length);
  els.imageCount.textContent = String(countImages);
  els.roundCount.textContent = String(currentState.round || 0);
  els.phaseText.textContent = currentState.message || "Chưa bắt đầu";
  els.detailText.textContent = currentState.error || currentState.detail || "";

  if (currentState.productName && document.activeElement !== els.productName) {
    els.productName.value = currentState.productName;
  }

  const progress = Math.max(0, Math.min(100, Number(currentState.progress) || 0));
  els.progressText.textContent = `${Math.round(progress)}%`;
  els.progressBar.style.width = `${progress}%`;

  els.statusBadge.className = "badge";
  if (currentState.error) {
    els.statusBadge.classList.add("error");
    els.statusBadge.textContent = "Có lỗi";
  } else if (currentState.running) {
    els.statusBadge.classList.add("running");
    els.statusBadge.textContent = "Đang quét";
  } else if (results.length > 0) {
    els.statusBadge.classList.add("done");
    els.statusBadge.textContent = "Hoàn thành";
  } else {
    els.statusBadge.classList.add("idle");
    els.statusBadge.textContent = "Sẵn sàng";
  }

  els.startBtn.disabled = currentState.running;
  els.stopBtn.disabled = !currentState.running;
  els.maxReviews.disabled = currentState.running;
  els.tryViewMore.disabled = currentState.running;
  els.autoScroll.disabled = currentState.running;
  els.deepImages.disabled = currentState.running;
  els.docxBtn.disabled = results.length === 0;
  els.docBtn.disabled = results.length === 0;
  els.csvBtn.disabled = results.length === 0;
  els.jsonBtn.disabled = results.length === 0;
  els.imagesBtn.disabled = countImages === 0;
  els.clearBtn.disabled = currentState.running;

  renderResults(filteredResults(results), results.length);
}

function renderResults(results, total) {
  if (!results.length) {
    els.resultList.innerHTML = total
      ? '<p class="empty">Không có kết quả khớp bộ lọc.</p>'
      : '<p class="empty">Chưa có dữ liệu.</p>';
    return;
  }

  els.resultList.innerHTML = results.slice(0, 12).map((review, index) => {
    const comment = escapeHtml(review.comment || "(Không có nội dung)");
    const variant = escapeHtml(review.productVariant || "Không rõ phân loại");
    const date = escapeHtml(review.date || "Không rõ ngày");
    const name = escapeHtml(review.reviewerName || "Người mua");
    const originalIndex = review.index || index + 1;
    return `
      <article class="result-card">
        <div class="result-head">
          <span>#${originalIndex} · ${escapeHtml(review.rating ?? "?")}★</span>
          <span>${date}</span>
        </div>
        <div class="reviewer">${name}</div>
        <p class="result-comment">${comment}</p>
        <div class="result-meta">${variant} · ${review.images?.length || 0} ảnh</div>
      </article>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Các cụm rác người mua hay thêm vào bình luận. Thêm mẫu mới vào đây nếu cần.
const JUNK_COMMENT_PATTERNS = [
  /\b(?:pic(?:ture)?|photo|image)s?\s*not\s*related\b/gi
];

function cleanReviewComment(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();

  // Bỏ token đếm "+1", "+2"... (rác do TikTok gộp) ở mọi vị trí, không chỉ ở cuối.
  text = text.replace(/\s*\+\d+(?=\s|$)/g, "");

  // Bỏ các câu rác ("picture not related"...) ở đầu, giữa hoặc cuối.
  for (const pattern of JUNK_COMMENT_PATTERNS) text = text.replace(pattern, " ");

  // Dọn dấu câu và khoảng trắng thừa còn sót lại sau khi xoá.
  return text
    .replace(/\s*,\s*(?=,|$)/g, "")
    .replace(/^[\s,.;:–—-]+/, "")
    .replace(/[\s,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedResults(state) {
  return (Array.isArray(state.results) ? state.results : []).map((review) => ({
    ...review,
    comment: cleanReviewComment(review.comment)
  }));
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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

function writeZipHeader(signature, size) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  return { bytes, view };
}

function createZipBlob(entries, type = "application/zip") {
  const encoder = new TextEncoder();
  const parts = [];
  const centralParts = [];
  const { time, date } = dosDateTime();
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name.replace(/\\/g, "/"));
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(data);

    const local = writeZipHeader(0x04034b50, 30 + name.length);
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

    const central = writeZipHeader(0x02014b50, 46 + name.length);
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

  const end = writeZipHeader(0x06054b50, 22);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, centralOffset, true);

  return new Blob([...parts, ...centralParts, end.bytes], { type });
}

function docxText(value, preserve = false) {
  const space = preserve ? ' xml:space="preserve"' : "";
  return `<w:t${space}>${escapeXml(value)}</w:t>`;
}

function docxParagraph(text, style = "") {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  const lines = String(text ?? "").split(/\r?\n/);
  const runs = lines.map((line, index) => (
    `<w:r>${index ? "<w:br/>" : ""}${docxText(line, true)}</w:r>`
  )).join("");
  return `<w:p>${styleXml}${runs || `<w:r>${docxText("")}</w:r>`}</w:p>`;
}

function docxLabeledParagraph(label, value) {
  return `<w:p>
    <w:r><w:rPr><w:b/></w:rPr>${docxText(`${label}: `, true)}</w:r>
    <w:r>${docxText(value || "Không rõ", true)}</w:r>
  </w:p>`;
}

function docxCell(content, width, shaded = false) {
  const fill = shaded ? '<w:shd w:fill="F3F4F6"/>' : "";
  return `<w:tc>
    <w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${fill}</w:tcPr>
    ${content}
  </w:tc>`;
}

function docxInfoRow(label, value) {
  return `<w:tr>
    ${docxCell(docxParagraph(label), 2300, true)}
    ${docxCell(docxParagraph(value || "Không rõ"), 6500)}
  </w:tr>`;
}

function docxReviewTable(review) {
  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="8800" w:type="dxa"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="6" w:color="D1D5DB"/>
        <w:left w:val="single" w:sz="6" w:color="D1D5DB"/>
        <w:bottom w:val="single" w:sz="6" w:color="D1D5DB"/>
        <w:right w:val="single" w:sz="6" w:color="D1D5DB"/>
        <w:insideH w:val="single" w:sz="6" w:color="E5E7EB"/>
        <w:insideV w:val="single" w:sz="6" w:color="E5E7EB"/>
      </w:tblBorders>
    </w:tblPr>
    ${docxInfoRow("Số sao", `${review.rating ?? "Không rõ"} sao`)}
    ${docxInfoRow("Người mua", review.reviewerName || "Không rõ")}
    ${docxInfoRow("Ngày", review.date || "Không rõ")}
    ${docxInfoRow("Phân loại", review.productVariant || "Không rõ")}
    ${docxInfoRow("Số ảnh", `${review.images?.length || 0} ảnh trong Images.zip`)}
  </w:tbl>`;
}

function buildDocxBlob(state, folderName) {
  const results = normalizedResults(state);
  const exportedAt = new Date().toLocaleString("vi-VN");
  const body = [
    docxParagraph(folderName, "Title"),
    docxLabeledParagraph("Tổng số bình luận", String(results.length)),
    docxLabeledParagraph("Tổng số ảnh", `${imageCount(results)} ảnh trong Images.zip`),
    docxLabeledParagraph("Nguồn", state.sourceUrl || "TikTok Shop"),
    docxLabeledParagraph("Xuất lúc", exportedAt),
    docxParagraph("")
  ];

  results.forEach((review, index) => {
    body.push(
      docxParagraph(`Review #${index + 1}`, "Heading1"),
      docxReviewTable(review),
      docxParagraph("Bình luận", "Heading2"),
      docxParagraph(review.comment || "(Không có nội dung bình luận)"),
      docxParagraph("")
    );
  });

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${body.join("\n")}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`;

  return createZipBlob([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    },
    {
      name: "word/_rels/document.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`
    },
    { name: "word/document.xml", data: documentXml },
    { name: "word/styles.xml", data: stylesXml }
  ], "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function buildCsv(state) {
  const rows = normalizedResults(state);
  const header = [
    "index",
    "rating",
    "reviewer",
    "date",
    "variant",
    "comment",
    "image_count",
    "image_urls"
  ];
  const body = rows.map((review, index) => [
    index + 1,
    review.rating ?? "",
    review.reviewerName || "",
    review.date || "",
    review.productVariant || "",
    review.comment || "",
    review.images?.length || 0,
    (review.images || []).join(" ")
  ].map(csvCell).join(","));

  return [header.map(csvCell).join(","), ...body].join("\r\n");
}

function buildHtmlDocument(state, folderName) {
  const results = normalizedResults(state);
  const exportedAt = new Date().toLocaleString("vi-VN");
  const rows = results.map((review, index) => {
    const rating = review.rating ?? "Không rõ";
    const date = review.date || "Không rõ";
    const variant = review.productVariant || "Không rõ";
    const reviewerName = review.reviewerName || "Không rõ";
    const comment = review.comment || "(Không có nội dung bình luận)";
    const imageTotal = review.images?.length || 0;

    return `
      <section class="review">
        <h2>Review #${index + 1}</h2>
        <table>
          <tr><td class="label">Số sao</td><td>${escapeHtml(rating)} sao</td></tr>
          <tr><td class="label">Người mua</td><td>${escapeHtml(reviewerName)}</td></tr>
          <tr><td class="label">Ngày</td><td>${escapeHtml(date)}</td></tr>
          <tr><td class="label">Phân loại</td><td>${escapeHtml(variant)}</td></tr>
          <tr><td class="label">Số ảnh</td><td>${imageTotal} ảnh trong Images.zip</td></tr>
        </table>
        <h3>Bình luận</h3>
        <p class="comment">${escapeHtml(comment)}</p>
      </section>`;
  }).join("\n");

  return `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(folderName)} - Reviews</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #111; }
    h1 { font-size: 20pt; margin-bottom: 4pt; }
    h2 { font-size: 13pt; margin: 0 0 6pt; }
    h3 { font-size: 11pt; margin: 8pt 0 2pt; }
    .meta { color: #555; margin-bottom: 16pt; }
    .review { border-bottom: 1px solid #ccc; padding: 0 0 14pt; margin: 0 0 14pt; page-break-inside: avoid; }
    table { border-collapse: collapse; margin-bottom: 7pt; width: 100%; }
    td { border: 1px solid #ddd; padding: 4pt 6pt; vertical-align: top; }
    td.label { font-weight: bold; width: 90pt; background: #f3f4f6; }
    .comment { margin: 6pt 0 0; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>${escapeHtml(folderName)}</h1>
  <p class="meta">Tổng số bình luận: ${results.length}<br>Tổng số ảnh: ${imageCount(results)}<br>Nguồn: ${escapeHtml(state.sourceUrl || "TikTok Shop")}<br>Xuất lúc: ${escapeHtml(exportedAt)}</p>
  ${rows || "<p>Không có bình luận.</p>"}
</body>
</html>`;
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
}

async function downloadDocx(state) {
  const folderName = sanitizeFolderName(els.productName.value || state.productName);
  els.productName.value = folderName;
  await downloadBlob(
    buildDocxBlob(state, folderName),
    `${folderName}/Reviews.docx`
  );
}

async function downloadHtml(state) {
  const folderName = sanitizeFolderName(els.productName.value || state.productName);
  els.productName.value = folderName;
  const html = buildHtmlDocument(state, folderName);
  await downloadBlob(
    new Blob(["\uFEFF", html], { type: "text/html;charset=utf-8" }),
    `${folderName}/Reviews.html`
  );
}

async function downloadCsv(state) {
  const folderName = sanitizeFolderName(els.productName.value || state.productName);
  els.productName.value = folderName;
  await downloadBlob(
    new Blob(["\uFEFF", buildCsv(state)], { type: "text/csv;charset=utf-8" }),
    `${folderName}/Reviews.csv`
  );
}

async function downloadJson(state) {
  const folderName = sanitizeFolderName(els.productName.value || state.productName);
  els.productName.value = folderName;
  const payload = {
    productName: folderName,
    sourceUrl: state.sourceUrl || "",
    exportedAt: new Date().toISOString(),
    results: normalizedResults(state)
  };
  await downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }),
    `${folderName}/Reviews.json`
  );
}

async function getState() {
  const { scraperState } = await chrome.storage.local.get("scraperState");
  return withDefaults(scraperState);
}

async function setButtonBusy(button, busyText, action) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    await action();
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 800);
  }
}

function renderDownloadProgress(progress) {
  if (!progress) {
    els.downloadText.textContent = "";
    return;
  }

  if (progress.total > 0) {
    els.downloadText.textContent = progress.zipping
      ? `Đang nén ZIP: ${progress.success}/${progress.total} ảnh · lỗi ${progress.failed}`
      : `Tải ảnh: ${progress.current}/${progress.total} · thành công ${progress.success} · lỗi ${progress.failed}`;
  }

  if (progress.finished) {
    setTimeout(() => {
      els.downloadText.textContent =
        `Tải ZIP ảnh xong: ${progress.success}/${progress.total}, lỗi ${progress.failed}.`;
    }, 200);
  }
}

els.startBtn.addEventListener("click", async () => {
  try {
    const maxReviews = clampMaxReviews(els.maxReviews.value);
    const productName = els.productName.value.trim();
    els.maxReviews.value = String(maxReviews);
    els.downloadText.textContent = "";

    await sendToActiveTab({
      type: "START_SCRAPE",
      options: {
        tryViewMore: els.tryViewMore.checked,
        autoScroll: els.autoScroll.checked,
        deepImages: els.deepImages.checked,
        maxReviews,
        productName
      }
    });
  } catch (error) {
    renderState({ ...DEFAULT_STATE, error: error.message });
  }
});

els.stopBtn.addEventListener("click", async () => {
  try {
    await sendToActiveTab({ type: "STOP_SCRAPE" });
  } catch (error) {
    renderState({ ...(await getState()), error: error.message });
  }
});

els.docxBtn.addEventListener("click", async () => {
  const state = await getState();
  if (!(state.results || []).length) return;
  await setButtonBusy(els.docxBtn, "Xuất...", () => downloadDocx(state));
});

els.docBtn.addEventListener("click", async () => {
  const state = await getState();
  if (!(state.results || []).length) return;
  await setButtonBusy(els.docBtn, "Xuất...", () => downloadHtml(state));
});

els.csvBtn.addEventListener("click", async () => {
  const state = await getState();
  if (!(state.results || []).length) return;
  await setButtonBusy(els.csvBtn, "Xuất...", () => downloadCsv(state));
});

els.jsonBtn.addEventListener("click", async () => {
  const state = await getState();
  if (!(state.results || []).length) return;
  await setButtonBusy(els.jsonBtn, "Xuất...", () => downloadJson(state));
});

els.imagesBtn.addEventListener("click", async () => {
  const state = await getState();
  const folderName = sanitizeFolderName(els.productName.value || state.productName);
  els.productName.value = folderName;
  const images = [];

  (state.results || []).forEach((review, reviewIndex) => {
    (review.images || []).forEach((url, imageIndex) => {
      images.push({ url, reviewIndex: reviewIndex + 1, imageIndex: imageIndex + 1 });
    });
  });

  if (!images.length) return;
  await setButtonBusy(els.imagesBtn, "Tải...", async () => {
    await chrome.runtime.sendMessage({ type: "DOWNLOAD_IMAGES", folderName, images });
  });
});

els.clearBtn.addEventListener("click", async () => {
  const state = await getState();
  if (state.running) return;
  await chrome.storage.local.set({
    scraperState: DEFAULT_STATE,
    downloadProgress: null
  });
  els.productName.value = "";
  els.maxReviews.value = String(DEFAULT_STATE.options.maxReviews);
  els.tryViewMore.checked = true;
  els.autoScroll.checked = true;
  els.deepImages.checked = false;
  els.searchInput.value = "";
  els.ratingFilter.value = "all";
  els.hasImageFilter.checked = false;
  renderDownloadProgress(null);
});

[els.searchInput, els.ratingFilter, els.hasImageFilter].forEach((element) => {
  element.addEventListener("input", () => renderState(currentState));
  element.addEventListener("change", () => renderState(currentState));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.scraperState) renderState(changes.scraperState.newValue);
  if (changes.downloadProgress) renderDownloadProgress(changes.downloadProgress.newValue);
});

getState().then(async (state) => {
  els.maxReviews.value = String(clampMaxReviews(state.options.maxReviews));
  els.tryViewMore.checked = state.options.tryViewMore !== false;
  els.autoScroll.checked = state.options.autoScroll !== false;
  els.deepImages.checked = state.options.deepImages === true;
  renderState(state);

  const { downloadProgress } = await chrome.storage.local.get("downloadProgress");
  renderDownloadProgress(downloadProgress);

  const tab = await getActiveTab();
  if (state.sourceUrl && tab?.url && state.sourceUrl !== tab.url) {
    els.productName.value = "";
  }
});
