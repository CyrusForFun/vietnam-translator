// ── State ──
const state = {
  botName: localStorage.getItem("bot_name") || "GPT-4o",
  autoInterval: parseInt(localStorage.getItem("auto_interval") || "5"),
  exchangeRate: null,
  stream: null,
  facingMode: "environment", // back camera for translating signs/menus
  autoTimer: null,
  isTranslating: false,
  lastResult: null,
};

// ── DOM ──
const $ = (sel) => document.querySelector(sel);
const video = $("#video");
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");

// Buttons
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

// Panels
const resultPanel = $("#resultPanel");
const resultContent = $("#resultContent");
const settingsModal = $("#settingsModal");
const imagePreview = $("#imagePreview");
const previewImg = $("#previewImg");
const scanOverlay = $("#scanOverlay");
const cameraPlaceholder = $("#cameraPlaceholder");
const statusDot = $("#statusDot");
const rateBadge = $("#rateBadge");

// Settings inputs
const selectModel = $("#selectModel");
const inputInterval = $("#inputInterval");

// ── Init ──
async function init() {
  loadSettings();
  await fetchExchangeRate();
  await startCamera();
  bindEvents();
  updateStatus();
}

function loadSettings() {
  selectModel.value = state.botName;
  inputInterval.value = state.autoInterval;
}

function saveSettings() {
  state.botName = selectModel.value;
  state.autoInterval = parseInt(inputInterval.value) || 5;

  localStorage.setItem("bot_name", state.botName);
  localStorage.setItem("auto_interval", String(state.autoInterval));

  updateStatus();
}

function updateStatus() {
  // Key is server-side now, always show connected
  statusDot.classList.add("connected");
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
    state.exchangeRate = 3200; // fallback
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
  // If there's a preview image, use that instead
  if (imagePreview.classList.contains("active")) {
    return getImagePreviewBase64();
  }

  if (!state.stream) return null;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  canvas.width = vw;
  canvas.height = vh;
  ctx.drawImage(video, 0, 0, vw, vh);

  // Return base64 without the data URL prefix
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return {
    base64: dataUrl.split(",")[1],
    mimeType: "image/jpeg",
  };
}

function getImagePreviewBase64() {
  const img = previewImg;
  const tempCanvas = document.createElement("canvas");
  const maxDim = 1920;
  let w = img.naturalWidth;
  let h = img.naturalHeight;

  if (w > maxDim || h > maxDim) {
    const ratio = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  tempCanvas.width = w;
  tempCanvas.height = h;
  const tempCtx = tempCanvas.getContext("2d");
  tempCtx.drawImage(img, 0, 0, w, h);

  const dataUrl = tempCanvas.toDataURL("image/jpeg", 0.85);
  return {
    base64: dataUrl.split(",")[1],
    mimeType: "image/jpeg",
  };
}

// ── Translate ──
async function translate() {
  if (state.isTranslating) return;

  const imageData = captureFrame();
  if (!imageData) {
    showResult('<div class="error-msg">無法擷取畫面，請確認相機已開啟或已上傳圖片</div>');
    return;
  }

  state.isTranslating = true;
  btnCapture.classList.add("loading");
  scanOverlay.classList.add("active");
  showResult('<div class="loading-indicator">翻譯中<span class="dots"></span></div>');

  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: imageData.base64,
        mimeType: imageData.mimeType,
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
    showResult(`<div class="error-msg">連線錯誤: ${escapeHtml(err.message)}</div>`);
  } finally {
    state.isTranslating = false;
    btnCapture.classList.remove("loading");
    scanOverlay.classList.remove("active");
  }
}

function renderTranslation(text) {
  // Try to parse structured blocks (原文/翻譯 format)
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
    // Fallback: show raw text nicely formatted
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

    // Match "原文：..." or "原文: ..."
    const origMatch = trimmed.match(/^原文[：:]\s*(.+)/);
    if (origMatch) {
      if (current && current.translated) blocks.push(current);
      current = { original: origMatch[1], translated: "", currency: "" };
      continue;
    }

    // Match "翻譯：..." or "翻譯: ..."
    const transMatch = trimmed.match(/^翻譯[：:]\s*(.+)/);
    if (transMatch) {
      if (!current) current = { original: "", translated: "", currency: "" };
      current.translated = transMatch[1];
      continue;
    }

    // Match currency lines (💰 ...)
    const currMatch = trimmed.match(/^💰\s*(.+)/);
    if (currMatch) {
      if (!current) current = { original: "", translated: "", currency: "" };
      current.currency = currMatch[1];
      continue;
    }

    // If we have a current block and no match, append to translated
    if (current) {
      if (!current.translated) {
        current.translated = trimmed;
      } else {
        current.translated += "\n" + trimmed;
      }
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
    imagePreview.classList.add("active");
    video.style.display = "none";
    // Auto-translate the uploaded image
    setTimeout(() => translate(), 300);
  };
  reader.readAsDataURL(file);
  // Reset input so same file can be re-selected
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
