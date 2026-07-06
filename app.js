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

// ── Status display (reuse rateBadge area or create new) ──
function setStatus(msg) {
  console.log("[status]", msg);
  document.title = msg;
}

// ── Init ──
async function init() {
  inputInterval.value = state.autoInterval;
  fetchExchangeRate();
  await startCamera();
  bindEvents();
  // Init OCR — show progress in result panel
  await initOCR();
}

// ── OCR ──
async function initOCR() {
  showResult('<div class="loading-indicator">正在載入 OCR 引擎...<br><span style="font-size:12px;opacity:0.6">首次載入需下載語言包（約 5MB）</span><span class="dots"></span></div>');
  setStatus("Loading OCR...");

  try {
    if (typeof Tesseract === "undefined") {
      throw new Error("Tesseract.js 未能載入，請檢查網路連線");
    }

    state.ocrWorker = await Tesseract.createWorker("vie+eng", 1, {
      logger: (m) => {
        if (m.status === "loading tesseract core") {
          showResult('<div class="loading-indicator">載入 OCR 核心引擎...<span class="dots"></span></div>');
        } else if (m.status === "initializing tesseract") {
          showResult('<div class="loading-indicator">初始化 OCR...<span class="dots"></span></div>');
        } else if (m.status === "loading language traineddata") {
          const pct = m.progress ? Math.round(m.progress * 100) : 0;
          showResult(`<div class="loading-indicator">下載越南語語言包... ${pct}%<span class="dots"></span></div>`);
        } else if (m.status === "initializing api") {
          showResult('<div class="loading-indicator">準備就緒...<span class="dots"></span></div>');
        }
      },
    });

    state.ocrReady = true;
    statusDot.classList.add("connected");
    setStatus("VN Translate - Ready");
    closeResult();
    console.log("[OCR] Ready - vie+eng");
  } catch (err) {
    console.error("[OCR] Init failed:", err);
    setStatus("OCR Failed");
    showResult(`<div class="error-msg">OCR 引擎載入失敗<br><br>${escapeHtml(err.message)}<br><br><span style="font-size:12px">請重新整理頁面再試</span></div>`);
  }
}

async function runOCR(imageSource) {
  if (!state.ocrReady || !state.ocrWorker) {
    throw new Error("OCR 引擎尚未就緒，請等待載入完成後再試");
  }

  // Convert canvas to blob for better compatibility across devices
  let input = imageSource;
  if (imageSource instanceof HTMLCanvasElement) {
    input = await new Promise((resolve, reject) => {
      imageSource.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Canvas toBlob failed"))),
        "image/png"
      );
    });
  }

  const { data } = await state.ocrWorker.recognize(input);
  return data.text;
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
      video: { facingMode: state.facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = state.stream;
    cameraPlaceholder.style.display = "none";
    video.style.display = "block";

    // Wait for video to actually be ready
    await new Promise((resolve) => {
      if (video.readyState >= 2) {
        state.videoReady = true;
        resolve();
      } else {
        video.onloadeddata = () => {
          state.videoReady = true;
          resolve();
        };
      }
      // Timeout after 5 seconds
      setTimeout(() => { state.videoReady = true; resolve(); }, 5000);
    });

    console.log("[Camera] Ready:", video.videoWidth, "x", video.videoHeight);
  } catch (err) {
    console.warn("[Camera] Error:", err);
    cameraPlaceholder.style.display = "flex";
    video.style.display = "none";
  }
}

function flipCamera() {
  state.facingMode = state.facingMode === "environment" ? "user" : "environment";
  startCamera();
}

// ── Capture ──
function captureForOCR() {
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

  if (!w || !h) {
    console.warn("[Capture] No dimensions:", w, h);
    return null;
  }

  const maxDim = 1536;
  let cw = w, ch = h;
  if (cw > maxDim || ch > maxDim) {
    const r = Math.min(maxDim / cw, maxDim / ch);
    cw = Math.round(cw * r);
    ch = Math.round(ch * r);
  }
  canvas.width = cw;
  canvas.height = ch;
  ctx.drawImage(source, 0, 0, cw, ch);
  console.log("[Capture] Got frame:", cw, "x", ch);
  return canvas;
}

// ── Translate: OCR → Google Translate ──
async function translate() {
  if (state.isTranslating) return;

  if (!state.ocrReady) {
    showResult('<div class="error-msg">OCR 引擎仍在載入中，請稍候...</div>');
    return;
  }

  const imgSource = captureForOCR();
  if (!imgSource) {
    showResult('<div class="error-msg">無法擷取畫面<br><span style="font-size:12px;opacity:0.6">請確認已允許相機權限，或上傳圖片</span></div>');
    return;
  }

  state.isTranslating = true;
  btnCapture.classList.add("loading");
  scanOverlay.classList.add("active");
  showResult('<div class="loading-indicator">正在辨識文字...<span class="dots"></span></div>');

  try {
    // Step 1: OCR
    console.log("[Translate] Running OCR...");
    const ocrText = await runOCR(imgSource);
    console.log("[Translate] OCR result:", ocrText.slice(0, 200));

    if (!ocrText.trim()) {
      showResult('<div class="no-text">未偵測到文字<br><span style="font-size:12px;opacity:0.6">請靠近文字、確保光線充足再試</span></div>');
      return;
    }

    showResult(`<div class="loading-indicator">辨識到文字，正在翻譯...<span class="dots"></span></div>`);

    // Step 2: Translate via server (Google Translate, free)
    console.log("[Translate] Calling API...");
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: ocrText,
        exchangeRate: state.exchangeRate || 3200,
      }),
    });

    if (!res.ok) {
      throw new Error(`Server error: ${res.status}`);
    }

    const data = await res.json();
    console.log("[Translate] API response:", data);

    if (data.error) {
      showResult(`<div class="error-msg">${escapeHtml(data.error)}</div>`);
    } else if (data.translation) {
      state.lastResult = data.translation;
      renderTranslation(data.translation);
    } else {
      showResult('<div class="no-text">未收到翻譯結果</div>');
    }
  } catch (err) {
    console.error("[Translate] Error:", err);
    showResult(`<div class="error-msg">錯誤: ${escapeHtml(err.message)}</div>`);
  } finally {
    state.isTranslating = false;
    btnCapture.classList.remove("loading");
    scanOverlay.classList.remove("active");
  }
}

// ── Render ──
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

function showResult(html) {
  resultContent.innerHTML = html;
  resultPanel.classList.add("open");
}
function closeResult() { resultPanel.classList.remove("open"); }

// ── Auto ──
function toggleAuto() {
  if (autoToggle.checked) {
    // Run once immediately, then repeat
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
      setTimeout(translate, 300);
    };
  };
  reader.readAsDataURL(file);
  fileInput.value = "";
}

function closePreview() {
  imagePreview.classList.remove("active");
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

  let touchY = 0;
  resultPanel.addEventListener("touchstart", (e) => { touchY = e.touches[0].clientY; });
  resultPanel.addEventListener("touchmove", (e) => { if (e.touches[0].clientY - touchY > 60) closeResult(); });
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

init();
