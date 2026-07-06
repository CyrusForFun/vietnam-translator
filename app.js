// ── State ──
const state = {
  botName: localStorage.getItem("bot_name") || "GPT-4o-Mini",
  autoInterval: parseInt(localStorage.getItem("auto_interval") || "5"),
  exchangeRate: null,
  stream: null,
  facingMode: "environment",
  autoTimer: null,
  isTranslating: false,
  lastResult: null,
  ocrWorker: null,
  ocrReady: false,
};

// ── DOM ──
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

const selectModel = $("#selectModel");
const inputInterval = $("#inputInterval");

// ── Init ──
async function init() {
  loadSettings();
  updateStatus();
  fetchExchangeRate();
  startCamera();
  initOCR();
  bindEvents();
}

// ── OCR (Tesseract.js) ──
async function initOCR() {
  try {
    statusDot.classList.remove("connected");
    state.ocrWorker = await Tesseract.createWorker("vie+eng", 1, {
      logger: (m) => {
        if (m.status === "recognizing text") {
          // Could show progress here
        }
      },
    });
    state.ocrReady = true;
    updateStatus();
    console.log("[OCR] Tesseract ready (vie+eng)");
  } catch (err) {
    console.error("[OCR] Init failed:", err);
  }
}

async function runOCR(imageSource) {
  if (!state.ocrWorker || !state.ocrReady) {
    throw new Error("OCR 引擎未就緒，請稍候...");
  }
  const result = await state.ocrWorker.recognize(imageSource);
  return result.data.text;
}

// ── Settings ──
function loadSettings() {
  selectModel.value = state.botName;
  inputInterval.value = state.autoInterval;
}

function saveSettings() {
  state.botName = selectModel.value;
  state.autoInterval = parseInt(inputInterval.value) || 5;
  localStorage.setItem("bot_name", state.botName);
  localStorage.setItem("auto_interval", String(state.autoInterval));
  // Restart auto timer if active
  if (autoToggle.checked) {
    toggleAuto();
    autoToggle.checked = true;
    toggleAuto();
  }
}

function updateStatus() {
  statusDot.classList.toggle("connected", state.ocrReady);
}

// ── Exchange Rate ──
async function fetchExchangeRate() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/HKD");
    const data = await res.json();
    if (data.rates && data.rates.VND) {
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
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
    }
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = state.stream;
    cameraPlaceholder.style.display = "none";
    video.style.display = "block";
  } catch (err) {
    console.warn("Camera error:", err);
    cameraPlaceholder.style.display = "flex";
    video.style.display = "none";
  }
}

function flipCamera() {
  state.facingMode = state.facingMode === "environment" ? "user" : "environment";
  startCamera();
}

// ── Capture ──
function captureFrame() {
  if (imagePreview.classList.contains("active")) {
    return previewImg;
  }

  if (!state.stream) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  canvas.width = vw;
  canvas.height = vh;
  ctx.drawImage(video, 0, 0, vw, vh);
  return canvas;
}

// ── Translate Pipeline: OCR → Poe API ──
async function translate() {
  if (state.isTranslating) return;

  const imageSource = captureFrame();
  if (!imageSource) {
    showResult('<div class="error-msg">無法擷取畫面，請確認相機已開啟或已上傳圖片</div>');
    return;
  }

  state.isTranslating = true;
  btnCapture.classList.add("loading");
  scanOverlay.classList.add("active");
  showResult('<div class="loading-indicator">辨識文字中<span class="dots"></span></div>');

  try {
    // Step 1: OCR
    const ocrText = await runOCR(imageSource);
    console.log("[OCR] Extracted:", ocrText.slice(0, 200));

    if (!ocrText.trim()) {
      showResult('<div class="no-text">未偵測到文字<br><span style="font-size:12px;opacity:0.6">請對準有文字的地方再試</span></div>');
      return;
    }

    showResult('<div class="loading-indicator">翻譯中<span class="dots"></span></div>');

    // Step 2: Send to Poe for translation
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: ocrText,
        botName: state.botName,
        exchangeRate: state.exchangeRate || 3200,
      }),
    });

    const data = await res.json();

    if (data.error) {
      showResult(`<div class="error-msg">${escapeHtml(data.error)}</div>`);
    } else if (data.translation) {
      state.lastResult = data.translation;
      renderTranslation(data.translation);
    } else {
      showResult('<div class="no-text">未收到翻譯結果</div>');
    }
  } catch (err) {
    showResult(`<div class="error-msg">${escapeHtml(err.message)}</div>`);
  } finally {
    state.isTranslating = false;
    btnCapture.classList.remove("loading");
    scanOverlay.classList.remove("active");
  }
}

// ── Render Translation ──
function renderTranslation(text) {
  const blocks = parseTranslationBlocks(text);

  if (blocks.length > 0) {
    const html = blocks
      .map((b) => {
        let inner = "";
        if (b.original) {
          inner += `<div class="original">${escapeHtml(b.original)}</div>`;
        }
        inner += `<div class="translated">${escapeHtml(b.translated)}</div>`;
        if (b.currency) {
          inner += `<div class="currency">${escapeHtml(b.currency)}</div>`;
        }
        return `<div class="translation-block">${inner}</div>`;
      })
      .join("");
    showResult(html);
  } else {
    showResult(`<div class="raw-translation">${escapeHtml(text)}</div>`);
  }
}

function parseTranslationBlocks(text) {
  const blocks = [];
  const lines = text.split("\n");
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current && current.translated) {
        blocks.push(current);
        current = null;
      }
      continue;
    }

    const origMatch = trimmed.match(/^原文[：:]\s*(.+)/);
    if (origMatch) {
      if (current && current.translated) blocks.push(current);
      current = { original: origMatch[1], translated: "", currency: "" };
      continue;
    }

    const transMatch = trimmed.match(/^翻譯[：:]\s*(.+)/);
    if (transMatch) {
      if (!current) current = { original: "", translated: "", currency: "" };
      current.translated = transMatch[1];
      continue;
    }

    const currMatch = trimmed.match(/^💰\s*(.+)/);
    if (currMatch) {
      if (!current) current = { original: "", translated: "", currency: "" };
      current.currency = currMatch[1];
      continue;
    }

    if (current) {
      if (!current.translated) current.translated = trimmed;
      else current.translated += "\n" + trimmed;
    }
  }

  if (current && current.translated) blocks.push(current);
  return blocks;
}

function showResult(html) {
  resultContent.innerHTML = html;
  resultPanel.classList.add("open");
}

function closeResult() {
  resultPanel.classList.remove("open");
}

// ── Auto translate ──
function toggleAuto() {
  if (autoToggle.checked) {
    state.autoTimer = setInterval(() => {
      if (!state.isTranslating && !imagePreview.classList.contains("active")) {
        translate();
      }
    }, state.autoInterval * 1000);
  } else {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
  }
}

// ── Image Upload ──
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    previewImg.src = ev.target.result;
    previewImg.onload = () => {
      imagePreview.classList.add("active");
      video.style.display = "none";
      setTimeout(() => translate(), 200);
    };
  };
  reader.readAsDataURL(file);
  fileInput.value = "";
}

function closePreview() {
  imagePreview.classList.remove("active");
  if (state.stream) {
    video.style.display = "block";
  } else {
    cameraPlaceholder.style.display = "flex";
  }
}

// ── Events ──
function bindEvents() {
  btnCapture.addEventListener("click", translate);
  btnUpload.addEventListener("click", () => fileInput.click());
  btnFlipCamera.addEventListener("click", flipCamera);
  btnSettings.addEventListener("click", () => {
    loadSettings();
    settingsModal.classList.add("open");
  });
  btnHistory.addEventListener("click", () => {
    if (state.lastResult) {
      renderTranslation(state.lastResult);
    } else {
      showResult('<div class="no-text">尚無翻譯記錄</div>');
    }
  });
  btnCloseResult.addEventListener("click", closeResult);
  $("#resultHandle").addEventListener("click", closeResult);
  btnClosePreview.addEventListener("click", closePreview);
  btnSaveSettings.addEventListener("click", () => {
    saveSettings();
    settingsModal.classList.remove("open");
  });
  btnCancelSettings.addEventListener("click", () => {
    settingsModal.classList.remove("open");
  });
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) settingsModal.classList.remove("open");
  });
  autoToggle.addEventListener("change", toggleAuto);
  fileInput.addEventListener("change", handleFileSelect);

  // Swipe down to close result panel
  let touchStartY = 0;
  resultPanel.addEventListener("touchstart", (e) => {
    touchStartY = e.touches[0].clientY;
  });
  resultPanel.addEventListener("touchmove", (e) => {
    const dy = e.touches[0].clientY - touchStartY;
    if (dy > 60) closeResult();
  });
}

// ── Util ──
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Boot ──
init();
