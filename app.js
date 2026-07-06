// ── State ──
const state = {
  autoInterval: parseInt(localStorage.getItem("auto_interval") || "5"),
  exchangeRate: null,
  stream: null,
  facingMode: "environment",
  autoTimer: null,
  isTranslating: false,
  lastResult: null,
  ocrWorker: null,
  ocrReady: false,
  videoReady: false,
};

const $ = (sel) => document.querySelector(sel);
const video = $("#video");
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
const overlayCanvas = $("#overlayCanvas");
const overlayCtx = overlayCanvas.getContext("2d");

const btnCapture = $("#btnCapture");
const btnUpload = $("#btnUpload");
const btnFlipCamera = $("#btnFlipCamera");
const btnSettings = $("#btnSettings");
const btnHistory = $("#btnHistory");
const btnCloseResult = $("#btnCloseResult");
const btnClosePreview = $("#btnClosePreview");
const btnSaveSettings = $("#btnSaveSettings");
const btnCancelSettings = $("#btnCancelSettings");
const autoToggle = $("#autoToggle");
const fileInput = $("#fileInput");

const resultPanel = $("#resultPanel");
const resultContent = $("#resultContent");
const settingsModal = $("#settingsModal");
const imagePreview = $("#imagePreview");
const previewImg = $("#previewImg");
const scanOverlay = $("#scanOverlay");
const cameraPlaceholder = $("#cameraPlaceholder");
const statusDot = $("#statusDot");
const rateBadge = $("#rateBadge");
const inputInterval = $("#inputInterval");

// ── Init ──
async function init() {
  inputInterval.value = state.autoInterval;
  fetchExchangeRate();
  await startCamera();
  bindEvents();
  await initOCR();
}

// ── OCR ──
async function initOCR() {
  showResult('<div class="loading-indicator">正在載入 OCR 引擎...<span class="dots"></span></div>');
  try {
    if (typeof Tesseract === "undefined") throw new Error("Tesseract.js 未能載入");

    state.ocrWorker = await Tesseract.createWorker("vie+eng", 1, {
      logger: (m) => {
        if (m.status === "loading language traineddata") {
          const pct = m.progress ? Math.round(m.progress * 100) : 0;
          showResult(`<div class="loading-indicator">下載語言包... ${pct}%<span class="dots"></span></div>`);
        }
      },
    });

    state.ocrReady = true;
    statusDot.classList.add("connected");
    closeResult();
  } catch (err) {
    showResult(`<div class="error-msg">OCR 載入失敗: ${escapeHtml(err.message)}</div>`);
  }
}

// Returns { text, lines: [{ text, bbox: {x0,y0,x1,y1} }] }
async function runOCR(imageSource) {
  if (!state.ocrReady) throw new Error("OCR 引擎尚未就緒");

  let input = imageSource;
  if (imageSource instanceof HTMLCanvasElement) {
    input = await new Promise((resolve, reject) => {
      imageSource.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
  }

  const { data } = await state.ocrWorker.recognize(input);

  const lines = (data.lines || [])
    .filter((l) => l.text.trim())
    .map((l) => ({
      text: l.text.trim(),
      bbox: l.bbox, // {x0, y0, x1, y1} in source image pixels
    }));

  return { text: data.text, lines };
}

// ── Exchange Rate ──
async function fetchExchangeRate() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/HKD");
    const data = await res.json();
    if (data.rates?.VND) {
      state.exchangeRate = Math.round(data.rates.VND);
      rateBadge.textContent = `\u{1F4B1} 1 HKD \u2248 ${state.exchangeRate.toLocaleString()} VND`;
    }
  } catch {
    state.exchangeRate = 3200;
    rateBadge.textContent = `\u{1F4B1} 1 HKD \u2248 3,200 VND (offline)`;
  }
}

// ── Camera ──
async function startCamera() {
  try {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = state.stream;
    cameraPlaceholder.style.display = "none";
    video.style.display = "block";

    await new Promise((resolve) => {
      if (video.readyState >= 2) { state.videoReady = true; resolve(); }
      else { video.onloadeddata = () => { state.videoReady = true; resolve(); }; }
      setTimeout(() => { state.videoReady = true; resolve(); }, 5000);
    });
  } catch {
    cameraPlaceholder.style.display = "flex";
    video.style.display = "none";
  }
}

function flipCamera() {
  state.facingMode = state.facingMode === "environment" ? "user" : "environment";
  hideOverlay();
  startCamera();
}

// ── Capture ──
function captureFrame() {
  let source, w, h;
  if (imagePreview.classList.contains("active")) {
    source = previewImg;
    w = source.naturalWidth;
    h = source.naturalHeight;
  } else if (state.stream && state.videoReady) {
    source = video;
    w = video.videoWidth;
    h = video.videoHeight;
  } else {
    return null;
  }
  if (!w || !h) return null;

  const maxDim = 1024;
  let cw = w, ch = h;
  if (cw > maxDim || ch > maxDim) {
    const r = Math.min(maxDim / cw, maxDim / ch);
    cw = Math.round(cw * r);
    ch = Math.round(ch * r);
  }
  canvas.width = cw;
  canvas.height = ch;
  ctx.drawImage(source, 0, 0, cw, ch);
  return { canvas, width: cw, height: ch };
}

// ── Overlay: draw translations on top of camera ──
function drawOverlay(frame, ocrLines, translatedLines) {
  const { width: fw, height: fh } = frame;

  // Set overlay to match the captured frame size
  overlayCanvas.width = fw;
  overlayCanvas.height = fh;

  // Draw the captured frame as background
  overlayCtx.drawImage(canvas, 0, 0, fw, fh);

  // Draw each translated line on top of its original position
  const lineCount = Math.min(ocrLines.length, translatedLines.length);

  for (let i = 0; i < lineCount; i++) {
    const line = ocrLines[i];
    const translated = translatedLines[i]?.trim();
    if (!translated || !line.bbox) continue;

    const { x0, y0, x1, y1 } = line.bbox;
    const boxW = x1 - x0;
    const boxH = y1 - y0;
    if (boxW < 5 || boxH < 5) continue;

    // Paint over original text with solid background
    overlayCtx.fillStyle = "rgba(20, 20, 30, 0.88)";
    const pad = 4;
    overlayCtx.fillRect(x0 - pad, y0 - pad, boxW + pad * 2, boxH + pad * 2);

    // Pick font size to fit the box
    let fontSize = Math.max(boxH * 0.75, 12);
    overlayCtx.font = `bold ${fontSize}px "PingFang TC", "Microsoft JhengHei", sans-serif`;
    overlayCtx.fillStyle = "#FFD166";
    overlayCtx.textBaseline = "middle";

    // Shrink font if text is wider than box
    let measured = overlayCtx.measureText(translated);
    while (measured.width > boxW + pad * 2 && fontSize > 10) {
      fontSize -= 1;
      overlayCtx.font = `bold ${fontSize}px "PingFang TC", "Microsoft JhengHei", sans-serif`;
      measured = overlayCtx.measureText(translated);
    }

    // Draw centered in the box
    const tx = x0 + (boxW - measured.width) / 2;
    const ty = y0 + boxH / 2;
    overlayCtx.fillText(translated, tx, ty);

    // Draw currency badge if detected
    const currencyMatch = line.text.match(/(\d[\d.,]*)\s*(?:₫|đ|d|dong|VND)\b/i);
    if (currencyMatch && state.exchangeRate) {
      const numStr = currencyMatch[1].replace(/[.,]/g, "");
      const amount = parseInt(numStr, 10);
      if (amount >= 1000) {
        const hkd = (amount / state.exchangeRate).toFixed(1);
        const badge = `≈ ${hkd} HKD`;
        overlayCtx.font = `bold ${Math.max(fontSize * 0.6, 10)}px sans-serif`;
        overlayCtx.fillStyle = "#06d6a0";
        overlayCtx.fillText(badge, x0, y1 + fontSize * 0.5);
      }
    }
  }

  overlayCanvas.classList.add("active");
}

function hideOverlay() {
  overlayCanvas.classList.remove("active");
}

// ── Translate ──
async function translate() {
  if (state.isTranslating) return;
  if (!state.ocrReady) {
    showResult('<div class="error-msg">OCR 引擎載入中...</div>');
    return;
  }

  const frame = captureFrame();
  if (!frame) {
    showResult('<div class="error-msg">無法擷取畫面</div>');
    return;
  }

  state.isTranslating = true;
  btnCapture.classList.add("loading");
  scanOverlay.classList.add("active");

  try {
    // Step 1: OCR with bounding boxes
    const ocr = await runOCR(frame.canvas);

    if (!ocr.lines.length) {
      showResult('<div class="no-text">未偵測到文字</div>');
      return;
    }

    // Step 2: Translate (single API call)
    const allText = ocr.lines.map((l) => l.text).join("\n");
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: allText, exchangeRate: state.exchangeRate || 3200 }),
    });

    if (!res.ok) throw new Error(`Server ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Step 3: Parse translated lines
    // API returns "原文：xxx\n翻譯：yyy\n\n原文：..." format
    // Extract just the 翻譯 lines
    const translatedLines = [];
    const rawLines = data.translation.split("\n");
    for (const rl of rawLines) {
      const m = rl.match(/^翻譯[：:]\s*(.+)/);
      if (m) translatedLines.push(m[1]);
    }

    // Fallback: if parsing fails, split the Google Translate raw output
    if (translatedLines.length === 0 && data.translation) {
      translatedLines.push(...data.translation.split("\n").filter((l) => l.trim()));
    }

    // Step 4: Draw overlay
    drawOverlay(frame, ocr.lines, translatedLines);

    // Also save for history
    state.lastResult = data.translation;

    // Close the bottom panel if open
    closeResult();
  } catch (err) {
    showResult(`<div class="error-msg">${escapeHtml(err.message)}</div>`);
  } finally {
    state.isTranslating = false;
    btnCapture.classList.remove("loading");
    scanOverlay.classList.remove("active");
  }
}

// ── Render (for history view) ──
function renderTranslation(text) {
  const blocks = parseBlocks(text);
  if (blocks.length > 0) {
    const html = blocks.map((b) => {
      let inner = "";
      if (b.original) inner += `<div class="original">${escapeHtml(b.original)}</div>`;
      inner += `<div class="translated">${escapeHtml(b.translated)}</div>`;
      if (b.currency) inner += `<div class="currency">${escapeHtml(b.currency)}</div>`;
      return `<div class="translation-block">${inner}</div>`;
    }).join("");
    showResult(html);
  } else {
    showResult(`<div class="raw-translation">${escapeHtml(text)}</div>`);
  }
}

function parseBlocks(text) {
  const blocks = [];
  const lines = text.split("\n");
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (cur?.translated) { blocks.push(cur); cur = null; } continue; }
    const om = t.match(/^原文[：:]\s*(.+)/);
    if (om) { if (cur?.translated) blocks.push(cur); cur = { original: om[1], translated: "", currency: "" }; continue; }
    const tm = t.match(/^翻譯[：:]\s*(.+)/);
    if (tm) { if (!cur) cur = { original: "", translated: "", currency: "" }; cur.translated = tm[1]; continue; }
    const cm = t.match(/^💰\s*(.+)/);
    if (cm) { if (!cur) cur = { original: "", translated: "", currency: "" }; cur.currency += (cur.currency ? " | " : "") + cm[1]; continue; }
    if (cur) { cur.translated ? (cur.translated += "\n" + t) : (cur.translated = t); }
  }
  if (cur?.translated) blocks.push(cur);
  return blocks;
}

function showResult(html) { resultContent.innerHTML = html; resultPanel.classList.add("open"); }
function closeResult() { resultPanel.classList.remove("open"); }

// ── Auto ──
function toggleAuto() {
  if (autoToggle.checked) {
    translate();
    state.autoTimer = setInterval(() => {
      if (!state.isTranslating && !imagePreview.classList.contains("active")) translate();
    }, state.autoInterval * 1000);
  } else {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
  }
}

// ── Upload ──
function handleFileSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    previewImg.src = ev.target.result;
    previewImg.onload = () => {
      imagePreview.classList.add("active");
      video.style.display = "none";
      hideOverlay();
      setTimeout(translate, 300);
    };
  };
  reader.readAsDataURL(file);
  fileInput.value = "";
}

function closePreview() {
  imagePreview.classList.remove("active");
  hideOverlay();
  state.stream ? (video.style.display = "block") : (cameraPlaceholder.style.display = "flex");
}

// ── Events ──
function bindEvents() {
  btnCapture.addEventListener("click", translate);
  btnUpload.addEventListener("click", () => fileInput.click());
  btnFlipCamera.addEventListener("click", flipCamera);
  btnSettings.addEventListener("click", () => { inputInterval.value = state.autoInterval; settingsModal.classList.add("open"); });
  btnHistory.addEventListener("click", () => {
    state.lastResult ? renderTranslation(state.lastResult) : showResult('<div class="no-text">尚無翻譯記錄</div>');
  });
  btnCloseResult.addEventListener("click", closeResult);
  $("#resultHandle").addEventListener("click", closeResult);
  btnClosePreview.addEventListener("click", closePreview);
  btnSaveSettings.addEventListener("click", () => {
    state.autoInterval = parseInt(inputInterval.value) || 5;
    localStorage.setItem("auto_interval", String(state.autoInterval));
    if (autoToggle.checked) { clearInterval(state.autoTimer); toggleAuto(); autoToggle.checked = true; }
    settingsModal.classList.remove("open");
  });
  btnCancelSettings.addEventListener("click", () => settingsModal.classList.remove("open"));
  settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.classList.remove("open"); });
  autoToggle.addEventListener("change", toggleAuto);
  fileInput.addEventListener("change", handleFileSelect);

  // Tap overlay to dismiss it
  overlayCanvas.addEventListener("click", hideOverlay);

  let touchY = 0;
  resultPanel.addEventListener("touchstart", (e) => { touchY = e.touches[0].clientY; });
  resultPanel.addEventListener("touchmove", (e) => { if (e.touches[0].clientY - touchY > 60) closeResult(); });
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

init();
