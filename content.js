(() => {
  if (window.__TIKTOK_REVIEW_SCRAPER_LOADED__) return;
  window.__TIKTOK_REVIEW_SCRAPER_LOADED__ = true;

  const RATING_SELECTOR = '[role="img"][aria-label]';
  const STATE_WRITE_INTERVAL = 850;
  const DEFAULT_OPTIONS = {
    tryViewMore: true,
    autoScroll: true,
    deepImages: false,
    maxReviews: 50
  };
  // Số lần tối đa bấm "ảnh kế tiếp" trong lightbox cho mỗi review.
  const LIGHTBOX_MAX_STEPS = 15;
  const DEFAULT_STATE = {
    running: false,
    phase: "idle",
    message: "Chưa bắt đầu",
    detail: "",
    round: 0,
    progress: 0,
    results: [],
    productName: "",
    sourceUrl: "",
    error: "",
    startedAt: null,
    finishedAt: null,
    options: DEFAULT_OPTIONS
  };

  let stopRequested = false;
  let activeRun = null;
  // Cấu hình quét ảnh sâu của lần chạy hiện tại. Để ở đây để finishRun dùng được
  // ở MỌI đường kết thúc, kể cả khi thoát sớm vì đã đủ số bình luận.
  let deepImagesEnabled = false;
  let expandedImageKeys = new Set();
  let stateCache = null;
  let lastStateWriteAt = 0;
  let pendingState = null;
  let pendingTimer = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function clampMaxReviews(value) {
    const parsed = Number.parseInt(value, 10);
    return Math.min(5000, Math.max(1, Number.isFinite(parsed) ? parsed : 50));
  }

  function withDefaults(scraperState) {
    return {
      ...DEFAULT_STATE,
      ...(scraperState || {}),
      options: { ...DEFAULT_OPTIONS, ...(scraperState?.options || {}) }
    };
  }

  async function readState({ fresh = false } = {}) {
    if (stateCache && !fresh) return stateCache;
    const { scraperState } = await chrome.storage.local.get("scraperState");
    stateCache = withDefaults(scraperState);
    return stateCache;
  }

  async function persistState(next, force = false) {
    stateCache = next;
    pendingState = next;

    const now = Date.now();
    const due = now - lastStateWriteAt >= STATE_WRITE_INTERVAL;
    if (!force && !due) {
      if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          if (pendingState) persistState(pendingState, true);
        }, Math.max(80, STATE_WRITE_INTERVAL - (now - lastStateWriteAt)));
      }
      return next;
    }

    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }

    pendingState = null;
    lastStateWriteAt = Date.now();
    await chrome.storage.local.set({ scraperState: next });
    try {
      await chrome.runtime.sendMessage({ type: "SCRAPER_STATE", state: next });
    } catch {
      // Popup có thể đang đóng.
    }
    return next;
  }

  async function writeState(patch, options = {}) {
    const current = await readState();
    const next = {
      ...current,
      ...patch,
      options: { ...DEFAULT_OPTIONS, ...(current.options || {}), ...(patch.options || {}) }
    };
    return persistState(next, options.force === true);
  }

  async function flushState() {
    if (pendingState) await persistState(pendingState, true);
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  // Các cụm rác người mua hay thêm vào bình luận. Thêm mẫu mới vào đây nếu cần.
  const JUNK_COMMENT_PATTERNS = [
    /\b(?:pic(?:ture)?|photo|image)s?\s*not\s*related\b/gi
  ];

  function cleanReviewComment(value) {
    let text = normalizeText(value);

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

  function normalizeForCompare(value) {
    return normalizeText(value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\u0111/g, "d"); // NFD kh\u00f4ng t\u00e1ch "\u0111"; \u00e9p v\u1ec1 "d" \u0111\u1ec3 kh\u1edbp "da xac minh", "danh gia"...
  }

  function sanitizeProductName(value) {
    const cleaned = normalizeText(value)
      .replace(/\s*[|·•]\s*(TikTok Shop|TikTok).*$/i, "")
      .replace(/\s*-\s*TikTok Shop.*$/i, "")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();

    const words = cleaned.split(" ").filter(Boolean).slice(0, 8);
    return words.join(" ").slice(0, 60).trim() || "TikTok Product";
  }

  function extractProductName() {
    const candidates = [
      document.querySelector('meta[property="og:title"]')?.content,
      document.querySelector('meta[name="twitter:title"]')?.content,
      [...document.querySelectorAll("h1")]
        .filter(isVisible)
        .map((element) => normalizeText(element.innerText || element.textContent))
        .sort((a, b) => b.length - a.length)[0],
      document.title
    ];

    for (const candidate of candidates) {
      const name = sanitizeProductName(candidate || "");
      if (name && !/^TikTok( Shop)?$/i.test(name)) return name;
    }

    return "TikTok Product";
  }

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function isRatingElement(element) {
    const label = normalizeForCompare(element.getAttribute("aria-label") || "");
    return (
      /^rating[:\s]/.test(label) ||
      label.includes("rating:") ||
      label.includes("danh gia") ||
      label.includes("sao") ||
      label.includes("star")
    );
  }

  function getRatingElements(scope = document) {
    return [...scope.querySelectorAll(RATING_SELECTOR)].filter((element) => (
      isVisible(element) && isRatingElement(element)
    ));
  }

  function parseRating(label) {
    const normalized = normalizeForCompare(label);
    const match = normalized.match(/(?:rating|danh gia)?[:\s]*(\d+(?:[.,]\d+)?)/i);
    if (!match) return null;
    const value = Number.parseFloat(match[1].replace(",", "."));
    return Number.isFinite(value) ? value : null;
  }

  function findViewMoreButton() {
    const accepted = new Set([
      "xem thêm",
      "xem tất cả",
      "xem tất cả đánh giá",
      "view more",
      "view more reviews",
      "see more",
      "show more",
      "view all reviews",
      "all reviews"
    ].map(normalizeForCompare));

    const selectors = 'button, a, [role="button"]';
    const buttonCandidates = [...document.querySelectorAll(selectors)].filter((element) => {
      const text = normalizeForCompare(element.innerText || element.textContent);
      return isVisible(element) && (
        accepted.has(text) ||
        text.startsWith("view more") ||
        text.startsWith("xem them") ||
        text.startsWith("see more") ||
        text.startsWith("show more")
      );
    });

    const textCandidates = [...document.querySelectorAll("span, div")]
      .filter((element) => {
        const text = normalizeForCompare(element.innerText || element.textContent);
        if (!isVisible(element) || !accepted.has(text)) return false;
        return Boolean(element.closest(selectors));
      })
      .map((element) => element.closest(selectors));

    const unique = [...new Set([...buttonCandidates, ...textCandidates])];
    unique.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const aScore = Math.abs(ar.width - 140) + Math.abs(ar.height - 36);
      const bScore = Math.abs(br.width - 140) + Math.abs(br.height - 36);
      return aScore - bScore;
    });
    return unique[0] || null;
  }

  async function tryOpenMoreReviews() {
    let button = null;

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      button = findViewMoreButton();
      if (button) break;
      await sleep(350);
    }

    if (!button) {
      return { found: false, clicked: false, changed: false, navigated: false };
    }

    const buttonText = normalizeText(button.innerText || button.textContent) || "Xem thêm / View more";
    await writeState({
      phase: "opening",
      message: "Đang tải thêm bình luận",
      detail: `Đang bấm "${buttonText}"...`
    });

    button.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await sleep(600);
    button = findViewMoreButton() || button;

    const beforeUrl = location.href;
    const beforeRatingCount = getRatingElements().length;
    const beforeButton = button;

    try {
      button.focus({ preventScroll: true });
    } catch {
      // Một số phần tử không hỗ trợ focus.
    }

    let clicked = false;
    try {
      button.click();
      clicked = true;
    } catch {
      // Sẽ thử click mô phỏng bên dưới.
    }

    await sleep(550);

    let navigated = location.href !== beforeUrl;
    let ratingChanged = getRatingElements().length !== beforeRatingCount;
    let buttonReplaced = !document.contains(beforeButton) || findViewMoreButton() !== beforeButton;
    let changed = navigated || ratingChanged || buttonReplaced;

    if (!changed && document.contains(button)) {
      const rect = button.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const target = document.elementFromPoint(centerX, centerY) || button;
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: centerX,
        clientY: centerY
      };

      try {
        if (window.PointerEvent) {
          target.dispatchEvent(new PointerEvent("pointerdown", eventOptions));
          target.dispatchEvent(new PointerEvent("pointerup", eventOptions));
        }
        target.dispatchEvent(new MouseEvent("mousedown", eventOptions));
        target.dispatchEvent(new MouseEvent("mouseup", eventOptions));
        target.dispatchEvent(new MouseEvent("click", eventOptions));
        clicked = true;
      } catch {
        // Bỏ qua nếu trang chặn sự kiện mô phỏng.
      }
    }

    for (let waitRound = 1; waitRound <= 12 && !changed; waitRound += 1) {
      await sleep(400);
      navigated = location.href !== beforeUrl;
      ratingChanged = getRatingElements().length !== beforeRatingCount;
      buttonReplaced = !document.contains(beforeButton) || findViewMoreButton() !== beforeButton;
      changed = navigated || ratingChanged || buttonReplaced;
    }

    return { found: true, clicked, changed, navigated };
  }

  async function expandReviewsUntilTarget(collected, maxReviews) {
    let clickCount = 0;
    let consecutiveNoGrowth = 0;
    const maxClicks = Math.min(250, Math.max(8, Math.ceil(maxReviews * 1.4)));

    while (!stopRequested && collected.size < maxReviews && clickCount < maxClicks) {
      const beforeSize = collected.size;
      mergeReviews(collected, scrapeVisibleReviews(), maxReviews);

      if (collected.size >= maxReviews) break;

      const clickResult = await tryOpenMoreReviews();
      if (!clickResult.found) break;

      clickCount += 1;

      for (let waitRound = 1; waitRound <= 14; waitRound += 1) {
        if (stopRequested || collected.size >= maxReviews) break;

        await sleep(420);
        mergeReviews(collected, scrapeVisibleReviews(), maxReviews);

        if (collected.size > beforeSize) break;
      }

      const gained = collected.size - beforeSize;
      consecutiveNoGrowth = gained > 0 ? 0 : consecutiveNoGrowth + 1;

      await writeState({
        running: true,
        phase: "opening",
        message: "Đang tải thêm bình luận",
        detail:
          `Đã bấm Xem thêm ${clickCount} lần · ` +
          `lần này thêm ${Math.max(0, gained)} · ` +
          `đã lưu ${collected.size}/${maxReviews}`,
        progress: Math.min(90, 10 + (collected.size / maxReviews) * 75),
        results: mapToResults(collected, maxReviews)
      });

      if (clickResult.navigated) {
        await flushState();
        return { clickCount, navigated: true, noGrowth: consecutiveNoGrowth };
      }

      if (consecutiveNoGrowth >= 3) break;
      await sleep(450);
    }

    return { clickCount, navigated: false, noGrowth: consecutiveNoGrowth };
  }

  function getReviewImageUrl(img) {
    return normalizeText(
      img.currentSrc ||
      img.getAttribute("src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-lazy-src") ||
      ""
    );
  }

  function findReviewRoot(ratingElement) {
    let node = ratingElement.parentElement;
    let lastUniqueRoot = null;

    while (node && node !== document.body) {
      const ratingCount = getRatingElements(node).length;
      if (ratingCount === 1) {
        const text = normalizeText(node.innerText);
        if (text.length > 10) lastUniqueRoot = node;
        node = node.parentElement;
        continue;
      }
      if (ratingCount > 1) break;
      node = node.parentElement;
    }
    return lastUniqueRoot;
  }

  function isMetadataLine(text) {
    const normalized = normalizeForCompare(text);
    return (
      !text ||
      /^20\d{2}[-/]\d{1,2}[-/]\d{1,2}$/.test(text) ||
      /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(text) ||
      /^(mat hang|item|product|variant|phan loai)\s*:/i.test(normalized) ||
      /da xac minh mua hang|verified purchase|rating:|danh gia/i.test(normalized) ||
      /^(helpful|like|reply|report)$/i.test(normalized)
    );
  }

  function getReviewComment(root) {
    const candidates = [...root.querySelectorAll('[class*="H4-Regular"], p, [data-e2e*="review"], span, div')]
      .map((element) => cleanReviewComment(element.innerText || element.textContent))
      .filter((text) => {
        if (!text || text.length < 5 || text.length > 1200) return false;
        if (isMetadataLine(text)) return false;
        const normalized = normalizeForCompare(text);
        if (/^(view|xem|show|see)\b/.test(normalized)) return false;
        return true;
      });

    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] || "";
  }

  function getReviewVariant(root) {
    const lines = (root.innerText || "").split("\n").map(normalizeText).filter(Boolean);
    const complete = lines.find((line) => /^(Mặt hàng|Item|Product|Variant|Phân loại)\s*:\s*.+/i.test(line));
    if (complete) return complete;

    const label = [...root.querySelectorAll("div, span, p")]
      .find((element) => /^(Mặt hàng|Item|Product|Variant|Phân loại)\s*:?\s*$/i.test(normalizeText(element.innerText)));
    if (!label) return "";

    let node = label.parentElement;
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      const text = normalizeText(node.innerText);
      if (text.length > normalizeText(label.innerText).length && text.length < 220) return text;
    }
    return normalizeText(label.innerText);
  }

  function getReviewDate(root) {
    const lines = (root.innerText || "").split("\n").map(normalizeText).filter(Boolean);
    return lines.find((line) => (
      /^20\d{2}[-/]\d{1,2}[-/]\d{1,2}$/.test(line) ||
      /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(line) ||
      /\b(days?|weeks?|months?|years?|ngày|tuần|tháng|năm)\b/i.test(line)
    )) || "";
  }

  function getReviewerName(root, comment, date, variant) {
    const skip = new Set([comment, date, variant].map(normalizeText).filter(Boolean));
    const lines = (root.innerText || "").split("\n").map(normalizeText).filter(Boolean);
    const name = lines.find((line) => (
      line.length >= 2 &&
      line.length <= 60 &&
      !skip.has(line) &&
      !isMetadataLine(line) &&
      !/^(\d+(\.\d+)?|[★*]+)$/.test(line)
    ));
    return name || "";
  }

  function isReviewImageUrl(url) {
    return /^https?:\/\/[^?#]*(ibyteimg|byteimg|tiktokcdn)/i.test(url);
  }

  // Mã băm của ảnh, ví dụ ".../1193c43cc1f14e4a8d5a4bab47400609~tplv-...webp" -> "1193c43c...".
  // Cùng một ảnh nhưng bản thumbnail và bản phóng to có URL khác nhau, chỉ giống mã băm này.
  function imageIdOf(url) {
    const match = String(url).match(/\/([0-9a-f]{16,})~/i);
    return match ? match[1].toLowerCase() : String(url).split("?")[0];
  }

  // Ưu tiên giữ bản ảnh lớn hơn khi trùng mã băm.
  function imageScore(url) {
    const size = String(url).match(/:(\d{2,4}):(\d{2,4})/);
    if (size) return Number(size[1]) * Number(size[2]);
    return /origin|tplv-[a-z0-9]+\.image/i.test(url) ? 1e7 : 1e6;
  }

  function dedupeImages(urls) {
    const byId = new Map();
    for (const url of urls) {
      if (!isReviewImageUrl(url)) continue;
      const id = imageIdOf(url);
      const old = byId.get(id);
      if (!old || imageScore(url) > imageScore(old)) byId.set(id, url);
    }
    return [...byId.values()];
  }

  function getRootImages(root) {
    const imageElements = [...root.querySelectorAll([
      'img[alt*="Product Review" i]',
      'img[alt*="review" i]',
      'img[src*="ibyteimg.com"]',
      'img[src*="byteimg.com"]',
      'img[data-src*="ibyteimg.com"]',
      'img[data-src*="byteimg.com"]'
    ].join(","))];

    return dedupeImages(imageElements.map(getReviewImageUrl));
  }

  // Chỉ giữ review thật: phải có comment VÀ có ngày HOẶC phân loại ("Mặt hàng:").
  // Loại: (a) card chỉ có "Đã xác minh mua hàng" (không comment);
  //       (b) thumbnail trong dải ảnh nổi bật đầu trang (không có ngày lẫn phân loại).
  function isRealReview(review) {
    return Boolean(review.comment && (review.date || review.productVariant));
  }

  // Trả về cả DOM node của từng review để phần quét ảnh sâu có thể bấm vào đúng card.
  function collectReviewCards() {
    const seenRoots = new Set();
    const cards = [];

    for (const ratingElement of getRatingElements()) {
      const root = findReviewRoot(ratingElement);
      if (!root || seenRoots.has(root) || !isVisible(root)) continue;
      seenRoots.add(root);

      const rating = parseRating(ratingElement.getAttribute("aria-label") || "");
      const date = getReviewDate(root);
      const productVariant = getReviewVariant(root);
      const comment = getReviewComment(root);
      const reviewerName = getReviewerName(root, comment, date, productVariant);
      const review = {
        rating,
        reviewerName,
        comment,
        date,
        productVariant,
        images: getRootImages(root)
      };

      if (isRealReview(review)) cards.push({ root, review });
    }

    return cards;
  }

  function scrapeVisibleReviews() {
    return collectReviewCards().map((card) => card.review);
  }

  function simulateClick(element) {
    const rect = element.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    try {
      if (window.PointerEvent) {
        element.dispatchEvent(new PointerEvent("pointerdown", options));
        element.dispatchEvent(new PointerEvent("pointerup", options));
      }
      element.dispatchEvent(new MouseEvent("mousedown", options));
      element.dispatchEvent(new MouseEvent("mouseup", options));
      element.dispatchEvent(new MouseEvent("click", options));
    } catch {
      // Trang có thể chặn sự kiện mô phỏng.
    }
  }

  function pressKey(key, keyCode) {
    const init = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent("keydown", init));
    document.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  // Badge "+4" đè lên thumbnail cuối, cho biết còn bao nhiêu ảnh chưa được nạp vào DOM.
  function findHiddenImageBadge(root) {
    return [...root.querySelectorAll("div, span")].find((element) => (
      /^\+\d+$/.test(normalizeText(element.innerText)) && isVisible(element)
    )) || null;
  }

  function badgeCount(badge) {
    const parsed = Number.parseInt(normalizeText(badge?.innerText).replace("+", ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function overlayCandidates() {
    return [...document.querySelectorAll([
      '[role="dialog"]',
      '[class*="mask" i]',
      '[class*="modal" i]',
      '[class*="preview" i]',
      '[class*="lightbox" i]',
      '[class*="viewer" i]'
    ].join(","))].filter(isVisible);
  }

  function findNewOverlay(before) {
    const now = overlayCandidates();
    const fresh = now.filter((element) => !before.has(element));
    // Overlay chứa nhiều ảnh review nhất chính là khung xem ảnh.
    const ranked = (fresh.length ? fresh : now)
      .sort((a, b) => getRootImages(b).length - getRootImages(a).length);
    return ranked[0] && getRootImages(ranked[0]).length ? ranked[0] : null;
  }

  function findNextButton(box) {
    const selectors = 'button, [role="button"], [class*="arrow" i], [class*="next" i]';
    return [...box.querySelectorAll(selectors)].find((element) => {
      if (!isVisible(element)) return false;
      const hint = normalizeForCompare(
        `${element.getAttribute("aria-label") || ""} ${element.className || ""}`
      );
      return /next|sau|tiep|right/.test(hint) && !/prev|truoc|left/.test(hint);
    }) || null;
  }

  async function goToNextImage(box) {
    const next = findNextButton(box);
    if (next) {
      simulateClick(next);
      return;
    }
    pressKey("ArrowRight", 39); // Không thấy nút mũi tên thì dùng phím.
  }

  async function closeOverlay(box) {
    pressKey("Escape", 27);
    await sleep(320);
    if (!document.contains(box) || !isVisible(box)) return;

    const closeButton = [...box.querySelectorAll('button, [role="button"], [class*="close" i]')]
      .find((element) => {
        if (!isVisible(element)) return false;
        const hint = normalizeForCompare(
          `${element.getAttribute("aria-label") || ""} ${element.className || ""}`
        );
        return /close|dong/.test(hint);
      });

    if (closeButton) {
      simulateClick(closeButton);
      await sleep(320);
    }
  }

  // Mở khung ảnh lớn của một review rồi thu toàn bộ URL ảnh trong đó.
  // Hỗ trợ cả 2 kiểu: lưới hiện hết ảnh, và carousel phải bấm sang từng ảnh.
  async function collectImagesFromLightbox(root) {
    const badge = findHiddenImageBadge(root);
    if (!badge) return [];

    const expected = badgeCount(badge);
    const before = new Set(overlayCandidates());
    const trigger = badge.closest('a, [role="button"], div, span') || badge;

    simulateClick(trigger);
    await sleep(800);

    let box = findNewOverlay(before);
    if (!box) {
      await sleep(700);
      box = findNewOverlay(before);
    }
    if (!box) return [];

    const found = new Map();
    const collect = () => {
      for (const url of getRootImages(box)) {
        const id = imageIdOf(url);
        const old = found.get(id);
        if (!old || imageScore(url) > imageScore(old)) found.set(id, url);
      }
    };

    collect();

    // Kiểu lưới: vòng lặp dừng ngay ở vòng 2 vì không có ảnh mới.
    // Kiểu carousel: bấm sang ảnh kế tiếp cho tới khi không còn ảnh mới.
    const maxSteps = Math.min(LIGHTBOX_MAX_STEPS, Math.max(3, expected + 2));
    let idleRounds = 0;

    for (let step = 0; step < maxSteps && idleRounds < 2; step += 1) {
      if (stopRequested) break;
      const beforeCount = found.size;
      await goToNextImage(box);
      await sleep(480);
      if (!document.contains(box)) break;
      collect();
      idleRounds = found.size > beforeCount ? 0 : idleRounds + 1;
    }

    await closeOverlay(box);
    await sleep(260);
    return [...found.values()];
  }

  // Duyệt các review đang hiển thị, mở khung ảnh lớn cho review nào còn ảnh ẩn sau badge "+N".
  async function expandVisibleReviewImages(collected, expandedKeys, maxReviews) {
    let expanded = 0;

    for (const { root, review } of collectReviewCards()) {
      if (stopRequested) break;

      const key = reviewKey(review);
      if (expandedKeys.has(key) || !document.contains(root)) continue;

      expandedKeys.add(key);
      if (!findHiddenImageBadge(root)) continue;

      root.scrollIntoView({ block: "center" });
      await sleep(320);

      const extra = await collectImagesFromLightbox(root);
      if (!extra.length) continue;

      mergeReviews(collected, [{ ...review, images: [...review.images, ...extra] }], maxReviews);
      expanded += 1;
    }

    return expanded;
  }

  // KHÔNG đưa URL ảnh vào khóa: ảnh tải lười nên cùng một review quét ở 2 thời điểm
  // sẽ có danh sách ảnh khác nhau -> bị tách thành 2 dòng. Danh tính review chỉ gồm
  // người mua + sao + nội dung + ngày + phân loại; ảnh sẽ được gộp dồn trong mergeReviews.
  function reviewKey(review) {
    return [
      review.reviewerName || "",
      review.rating ?? "",
      review.comment || "",
      review.date || "",
      review.productVariant || ""
    ].map(normalizeForCompare).join("|");
  }

  function mergeReviews(map, reviews, maxReviews = Infinity) {
    for (const review of reviews) {
      const key = reviewKey(review);
      if (!map.has(key)) {
        if (map.size >= maxReviews) break;
        map.set(key, review);
      } else {
        const old = map.get(key);
        // Gộp dồn ảnh: cùng mã băm thì giữ bản độ phân giải cao hơn.
        old.images = dedupeImages([...(old.images || []), ...(review.images || [])]);
        if (!old.productVariant && review.productVariant) old.productVariant = review.productVariant;
        if (!old.reviewerName && review.reviewerName) old.reviewerName = review.reviewerName;
      }
    }
  }

  function mapToResults(map, maxReviews) {
    return [...map.values()]
      .slice(0, maxReviews)
      .map((review, index) => ({ ...review, index: index + 1 }));
  }

  function findBestScroller() {
    const reviewRoots = getRatingElements().map(findReviewRoot).filter(Boolean);
    const ancestorScores = new Map();

    for (const root of reviewRoots) {
      let node = root.parentElement;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        const scrollable = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 120;
        if (scrollable) ancestorScores.set(node, (ancestorScores.get(node) || 0) + 1);
        node = node.parentElement;
      }
    }

    const ranked = [...ancestorScores.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0].scrollHeight - a[0].scrollHeight;
    });
    if (ranked[0]?.[0]) return ranked[0][0];

    const candidates = [
      document.querySelector('[role="dialog"]'),
      document.querySelector('[class*="modal" i]'),
      document.querySelector('[class*="review" i]'),
      document.scrollingElement,
      document.documentElement
    ].filter(Boolean);

    return candidates.find((element) => {
      const style = getComputedStyle(element);
      return (
        (element === document.scrollingElement || /(auto|scroll)/.test(style.overflowY)) &&
        element.scrollHeight > element.clientHeight + 120
      );
    }) || document.scrollingElement || document.documentElement;
  }

  function scrollMetrics(scroller) {
    const isDocument = (
      scroller === document.scrollingElement ||
      scroller === document.documentElement ||
      scroller === document.body
    );
    if (isDocument) {
      const top = window.scrollY;
      const client = window.innerHeight;
      const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      return { top, client, height, isDocument: true };
    }
    return {
      top: scroller.scrollTop,
      client: scroller.clientHeight,
      height: scroller.scrollHeight,
      isDocument: false
    };
  }

  async function moveScroller(scroller, top, smooth = false) {
    const metrics = scrollMetrics(scroller);
    if (metrics.isDocument) {
      window.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
    } else {
      scroller.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
    }
    await sleep(smooth ? 900 : 420);
  }

  async function finishRun(collected, maxReviews, stopped = false, customDetail = "") {
    // Chốt lại: mở khung ảnh lớn cho các review còn hiển thị mà chưa xử lý.
    // Bắt buộc nằm ở đây vì run có thể thoát sớm (đủ số bình luận) mà không qua vòng cuộn.
    if (deepImagesEnabled && !stopped && !stopRequested) {
      await writeState({
        phase: "images",
        message: "Đang lấy ảnh ẩn",
        detail: "Đang mở khung ảnh lớn của từng bình luận..."
      }, { force: true });
      await expandVisibleReviewImages(collected, expandedImageKeys, maxReviews);
    }

    const results = mapToResults(collected, maxReviews);
    const images = results.reduce((sum, item) => sum + (item.images?.length || 0), 0);
    await writeState({
      running: false,
      phase: stopped ? "stopped" : "done",
      message: stopped ? "Đã dừng" : "Hoàn thành",
      detail: customDetail || (
        stopped
          ? `Đã dừng và giữ lại ${results.length} bình luận.`
          : `Đã lưu ${results.length} bình luận và ${images} ảnh.`
      ),
      progress: 100,
      results,
      finishedAt: new Date().toISOString()
    }, { force: true });
  }

  async function runScrape(options = {}) {
    if (activeRun) return activeRun;

    stopRequested = false;
    activeRun = (async () => {
      const existingState = await readState({ fresh: true });
      const resume = options.resume === true;
      const maxReviews = clampMaxReviews(options.maxReviews ?? existingState.options.maxReviews);
      const productName = sanitizeProductName(
        options.productName || existingState.productName || extractProductName()
      );
      const mergedOptions = {
        ...DEFAULT_OPTIONS,
        ...existingState.options,
        ...options,
        maxReviews,
        productName
      };
      delete mergedOptions.resume;

      const collected = new Map();
      // Nhớ review nào đã mở khung ảnh lớn để không mở lại khi cuộn qua lần nữa.
      expandedImageKeys = new Set();
      deepImagesEnabled = mergedOptions.deepImages === true;
      if (resume) mergeReviews(collected, existingState.results || [], maxReviews);

      await writeState({
        running: true,
        phase: resume ? "resuming" : "starting",
        message: resume ? "Đang tiếp tục quét" : "Đang chuẩn bị",
        detail: resume
          ? `Đang tiếp tục từ ${collected.size}/${maxReviews} bình luận.`
          : "Chờ TikTok Shop tải khu vực bình luận...",
        round: resume ? existingState.round || 0 : 0,
        progress: resume ? Math.max(10, existingState.progress || 0) : 2,
        results: resume ? mapToResults(collected, maxReviews) : [],
        productName,
        sourceUrl: location.href,
        error: "",
        startedAt: resume ? existingState.startedAt || new Date().toISOString() : new Date().toISOString(),
        finishedAt: null,
        options: mergedOptions
      }, { force: true });

      try {
        await sleep(900);

        mergeReviews(collected, scrapeVisibleReviews(), maxReviews);
        await writeState({
          results: mapToResults(collected, maxReviews),
          detail: `Đã lấy ${collected.size}/${maxReviews} bình luận đang hiển thị.`,
          progress: Math.min(25, 5 + (collected.size / maxReviews) * 20)
        });

        if (collected.size >= maxReviews) {
          await finishRun(collected, maxReviews, false, `Đã đạt giới hạn ${maxReviews} bình luận.`);
          return;
        }

        if (mergedOptions.tryViewMore && !stopRequested) {
          await expandReviewsUntilTarget(collected, maxReviews);
          await sleep(450);
        }

        if (stopRequested) {
          await finishRun(collected, maxReviews, true);
          return;
        }

        await writeState({
          phase: "scanning",
          message: "Đang quét bình luận",
          detail: `Đang nhận diện các card đánh giá · ${collected.size}/${maxReviews}.`,
          progress: Math.max(15, Math.min(30, (collected.size / maxReviews) * 30))
        });
        await sleep(600);

        mergeReviews(collected, scrapeVisibleReviews(), maxReviews);
        await writeState({
          results: mapToResults(collected, maxReviews),
          detail: `Đã lấy ${collected.size}/${maxReviews} bình luận.`,
          progress: Math.max(25, Math.min(40, (collected.size / maxReviews) * 40))
        });

        if (collected.size >= maxReviews) {
          await finishRun(collected, maxReviews, false, `Đã đạt giới hạn ${maxReviews} bình luận.`);
          return;
        }

        if (!mergedOptions.autoScroll) {
          await finishRun(
            collected,
            maxReviews,
            false,
            `Đã lưu ${collected.size} bình luận đang hiển thị. Tự cuộn đang tắt.`
          );
          return;
        }

        let scroller = findBestScroller();
        await moveScroller(scroller, 0, false);

        let unchangedRounds = 0;
        let previousTotal = collected.size;
        let previousTop = -1;
        const maxRounds = Math.min(2200, Math.max(80, maxReviews * 3));
        const maxIdleRounds = 9;

        for (let round = 1; round <= maxRounds; round += 1) {
          if (stopRequested || collected.size >= maxReviews) break;

          const visible = scrapeVisibleReviews();
          mergeReviews(collected, visible, maxReviews);

          // Mở khung ảnh lớn ngay khi review còn nằm trong màn hình,
          // vì cuộn qua rồi thì DOM của nó có thể bị gỡ bỏ.
          if (deepImagesEnabled && !stopRequested) {
            await writeState({
              phase: "images",
              message: "Đang lấy ảnh ẩn",
              detail: `Vòng ${round}: đang mở khung ảnh lớn · đã lưu ${collected.size}/${maxReviews}`,
              round
            });
            await expandVisibleReviewImages(collected, expandedImageKeys, maxReviews);
          }

          const metrics = scrollMetrics(scroller);
          const countProgress = collected.size / maxReviews;
          const scrollProgress = metrics.height > metrics.client
            ? metrics.top / Math.max(1, metrics.height - metrics.client)
            : 1;
          const progress = Math.min(99, Math.max(30, 30 + Math.max(countProgress, scrollProgress) * 68));

          if (collected.size === previousTotal) {
            unchangedRounds += 1;
          } else {
            unchangedRounds = 0;
            previousTotal = collected.size;
          }

          await writeState({
            running: true,
            phase: "scrolling",
            message: "Đang cuộn và quét",
            detail: `Vòng ${round}: DOM ${visible.length} · đã lưu ${collected.size}/${maxReviews} · vị trí ${Math.round(metrics.top)}/${metrics.height}`,
            round,
            progress,
            results: mapToResults(collected, maxReviews)
          });

          if (collected.size >= maxReviews) break;

          const reachedBottom = metrics.top + metrics.client >= metrics.height - 24;
          const notMoving = Math.abs(metrics.top - previousTop) < 2;

          if (
            mergedOptions.tryViewMore &&
            collected.size < maxReviews &&
            ((reachedBottom && unchangedRounds >= 2) || unchangedRounds >= 4)
          ) {
            const beforeExpand = collected.size;
            await expandReviewsUntilTarget(collected, maxReviews);

            if (collected.size > beforeExpand) {
              unchangedRounds = 0;
              previousTotal = collected.size;
              const refreshedScroller = findBestScroller();
              if (refreshedScroller !== scroller) {
                scroller = refreshedScroller;
                await moveScroller(scroller, 0, false);
              }
              continue;
            }
          }

          if (reachedBottom && unchangedRounds >= 3) break;
          if (notMoving && unchangedRounds >= maxIdleRounds) break;

          previousTop = metrics.top;
          const nextTop = Math.min(
            metrics.height,
            metrics.top + Math.max(420, Math.round(metrics.client * 0.78))
          );
          await moveScroller(scroller, nextTop, true);
          await sleep(550);
        }

        if (stopRequested) {
          await finishRun(collected, maxReviews, true);
        } else if (collected.size >= maxReviews) {
          await finishRun(collected, maxReviews, false, `Đã đạt giới hạn ${maxReviews} bình luận.`);
        } else {
          await finishRun(
            collected,
            maxReviews,
            false,
            `Đã đến cuối dữ liệu đang tải được: ${collected.size}/${maxReviews} bình luận.`
          );
        }
      } catch (error) {
        const results = mapToResults(collected, maxReviews);
        await writeState({
          running: false,
          phase: stopRequested ? "stopped" : "error",
          message: stopRequested ? "Đã dừng" : "Quét gặp lỗi",
          detail: results.length
            ? `Đã giữ lại ${results.length} bình luận trước khi dừng.`
            : "Không lấy được dữ liệu.",
          progress: 100,
          results,
          error: stopRequested ? "" : String(error?.message || error),
          finishedAt: new Date().toISOString()
        }, { force: true });
      } finally {
        await flushState();
        activeRun = null;
      }
    })();

    return activeRun;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "START_SCRAPE") {
      runScrape({ ...(message.options || {}), resume: false });
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "STOP_SCRAPE") {
      stopRequested = true;
      writeState({
        message: "Đang dừng",
        detail: "Extension sẽ dừng sau vòng quét hiện tại."
      }, { force: true });
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "GET_VISIBLE_REVIEWS") {
      sendResponse({ ok: true, results: scrapeVisibleReviews() });
      return false;
    }

    return undefined;
  });

  readState({ fresh: true }).then((state) => {
    if (state.running && !activeRun) {
      setTimeout(() => {
        runScrape({
          ...(state.options || {}),
          productName: state.productName || state.options?.productName || "",
          resume: true
        });
      }, 1400);
    }
  });
})();
