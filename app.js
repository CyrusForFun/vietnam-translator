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

// ── Init ──
async function init() {
  inputInterval.value = state.autoInterval;
  fetchExchangeRate();
  startCamera();
  initOCR();
  bindEvents();
}

// ── OCR ──
async function initOCR() {
  try {
    showResult('<div class="loading-indicator">載入 OCR 引擎中（首次約 10 秒）<span class="dots"></span></div>');
    state.ocrWorker = await Tesseract.createWorker("vie+eng");
    state.ocrReady = true;
    statusDot.classList.add("connected");
    closeResult();
    console.log("[OCR] Ready");
  } catch (err) {
    console.error("[OCR] Failed:", err);
    showResult(`<div class="error-msg">OCR 載入失敗: ${err.message}</div>`);
  }
}

async function runOCR(imageSource) {
  if (!state.ocrReady) throw new Error("OCR 引擎載入中，請稍候...");
  const { data } = await state.ocrWorker.recognize(imageSource);
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
  } catch {
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
  } else if (state.stream) {
    source = video;
    w = video.videoWidth;
    h = video.videoHeight;
  } else {
    return null;
  }
  if (!w || !h) return null;

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
  return canvas;
}

// ── Translate: OCR → Google Translate ──
async function translate() {
  if (state.isTranslating) return;

  const imgSource = captureForOCR();
  if (!imgSource) {
    showResult('<div class="error-msg">無法擷取畫面</div>');
    return;
  }

  state.isTranslating = true;
  btnCapture.classList.add("loading");
  scanOverlay.classList.add("active");
  showResult('<div class="loading-indicator">辨識文字中<span class="dots"></span></div>');

  try {
    // Step 1: OCR
    const ocrText = await runOCR(imgSource);
    if (!ocrText.trim()) {
      showResult('<div class="no-text">未偵測到文字<br><span style="font-size:12px;opacity:0.6">請對準有文字的地方再試</span></div>');
      return;
    }

    showResult('<div class="loading-indicator">翻譯中<span class="dots"></span></div>');

    // Step 2: Translate via server (Google Translate, free)
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: ocrText,
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
      setTimeout(translate, 200);
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
