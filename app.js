(() => {
  "use strict";

  const CFG = window.TRUCK_CHECK_CONFIG;
  const $ = (id) => document.getElementById(id);

  const els = {
    video: $("video"),
    cameraFallback: $("cameraFallback"),
    cameraFallbackText: $("cameraFallbackText"),

    systemPill: $("systemPill"),
    systemText: $("systemText"),

    resultCard: $("resultCard"),
    resultMain: $("resultMain"),
    resultSub: $("resultSub"),

    sourceStatus: $("sourceStatus"),
    logStatus: $("logStatus"),
    ocrStatus: $("ocrStatus"),

    manualForm: $("manualForm"),
    manualInput: $("manualInput"),
    manualBtn: $("manualBtn"),

    modelCanvas: $("modelCanvas"),
    bodyCanvas: $("bodyCanvas"),
  };

  const state = {
    modelSession: null,
    stream: null,
    cameraReady: false,
    sourceReady: false,
    sourceMap: new Map(),
    sourceUpdatedAt: 0,

    running: false,
    paused: false,
    fastBusy: false,
    bodyBusy: false,
    bodyWorker: null,
    bodyReady: false,
    bodyInitPromise: null,

    lastTick: 0,
    lastBodyTick: 0,
    misses: 0,

    candidate: "",
    candidateCount: 0,
    candidateConfidence: 0,

    lastAcceptedPlate: "",
    lastAcceptedAt: 0,

    logQueue: [],
    logBusy: false,
    lastOcrMs: null,
  };

  const LOG_STORAGE_KEY = "truck_check_pending_logs_v2";

  function backendConfigured() {
    return (
      CFG.appsScriptUrl &&
      CFG.appsScriptUrl.startsWith("https://script.google.com/macros/s/") &&
      CFG.appsScriptUrl.endsWith("/exec")
    );
  }

  function setSystem(kind, text) {
    els.systemPill.className = `pill pill-${kind}`;
    els.systemText.textContent = text;
  }

  function setResult(kind, main, sub = "") {
    els.resultCard.className = `result result-${kind}`;
    els.resultMain.textContent = main;
    els.resultSub.textContent = sub;
  }

  function setOcrStatus(text) {
    els.ocrStatus.textContent = `OCR: ${text}`;
  }

  function updateSourceStatus() {
    if (!state.sourceReady) {
      els.sourceStatus.textContent = "Source: chưa có";
      return;
    }

    const ageSec = Math.max(
      0,
      Math.round((Date.now() - state.sourceUpdatedAt) / 1000),
    );

    els.sourceStatus.textContent =
      `Source: ${state.sourceMap.size.toLocaleString("vi-VN")} xe · ${ageSec}s`;
  }

  function updateLogStatus() {
    els.logStatus.textContent =
      state.logQueue.length > 0
        ? `Log: pending ${state.logQueue.length}`
        : "Log: OK";
  }

  function normalizePlate(text) {
    return String(text || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  }

  function extractPlate(text) {
    const normalized = normalizePlate(text);
    const match = normalized.match(/\d{2}[A-Z]{1,2}\d{4,5}/);
    return match ? match[0] : "";
  }

  function isValidPlate(plate) {
    return /^\d{2}[A-Z]{1,2}\d{4,5}$/.test(normalizePlate(plate));
  }

  // ==========================================================
  // JSONP BACKEND
  // Avoids CORS dependency between GitHub Pages and Apps Script.
  // ==========================================================

  let jsonpSeq = 0;

  function jsonp(params) {
    return new Promise((resolve, reject) => {
      if (!backendConfigured()) {
        reject(new Error("Chưa cấu hình Apps Script URL."));
        return;
      }

      const callbackName =
        `__truckCheckCb_${Date.now()}_${jsonpSeq++}`;

      const url = new URL(CFG.appsScriptUrl);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
      url.searchParams.set("callback", callbackName);
      url.searchParams.set("_", String(Date.now()));

      const script = document.createElement("script");
      script.async = true;
      script.src = url.toString();

      let finished = false;

      const cleanup = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { delete window[callbackName]; } catch (_) {}
        script.remove();
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Backend timeout."));
      }, CFG.backendTimeoutMs);

      window[callbackName] = (payload) => {
        cleanup();

        if (payload && payload.ok) {
          resolve(payload);
        } else {
          reject(
            new Error(payload?.error || "Backend trả lỗi."),
          );
        }
      };

      script.onerror = () => {
        cleanup();
        reject(new Error("Không gọi được Apps Script."));
      };

      document.head.appendChild(script);
    });
  }

  async function refreshSource() {
    if (!backendConfigured()) {
      state.sourceReady = false;
      updateSourceStatus();
      setSystem("error", "Chưa nối GSheet");
      setResult(
        "error",
        "CHƯA CẤU HÌNH GSHEET",
        "Paste Apps Script /exec URL vào config.js",
      );
      return false;
    }

    try {
      const payload = await jsonp({ action: "source" });

      const map = new Map();

      for (const row of payload.rows || []) {
        const plate = normalizePlate(row[0]);
        if (!plate) continue;

        map.set(plate, {
          priority: String(row[1] ?? ""),
          blacklist: String(row[2] ?? ""),
        });
      }

      if (map.size === 0) {
        throw new Error("Source H/F/J trả về 0 BKS.");
      }

      state.sourceMap = map;
      state.sourceReady = true;
      state.sourceUpdatedAt = Date.now();
      updateSourceStatus();

      if (state.cameraReady && state.modelSession) {
        setSystem("ready", "Sẵn sàng");
        setResult("idle", "Sẵn sàng quét", "Đưa BKS vào khung");
      }

      return true;
    } catch (err) {
      console.warn("Source refresh:", err);

      // Keep previous cache if it already exists.
      if (state.sourceMap.size > 0) {
        state.sourceReady = true;
        updateSourceStatus();
        setSystem("ready", "Dùng cache");
        return false;
      }

      state.sourceReady = false;
      updateSourceStatus();
      setSystem("error", "Mất dữ liệu");
      setResult(
        "error",
        "KHÔNG LOAD ĐƯỢC SOURCE",
        err?.message || String(err),
      );
      return false;
    }
  }

  // ==========================================================
  // PERSISTENT TEXT-ONLY LOG QUEUE
  // ==========================================================

  function loadPendingLogs() {
    try {
      const raw = localStorage.getItem(LOG_STORAGE_KEY);
      const arr = JSON.parse(raw || "[]");
      state.logQueue = Array.isArray(arr) ? arr : [];
    } catch (_) {
      state.logQueue = [];
    }
    updateLogStatus();
  }

  function savePendingLogs() {
    try {
      localStorage.setItem(
        LOG_STORAGE_KEY,
        JSON.stringify(state.logQueue),
      );
    } catch (_) {}
    updateLogStatus();
  }

  function queueScanLog(plate, timestampMs) {
    state.logQueue.push({
      id:
        `${timestampMs}_${plate}_` +
        Math.random().toString(36).slice(2, 9),
      plate,
      timestampMs,
    });
    savePendingLogs();
    void flushLogQueue();
  }

  async function flushLogQueue() {
    if (state.logBusy || !backendConfigured()) return;
    if (state.logQueue.length === 0) {
      updateLogStatus();
      return;
    }

    state.logBusy = true;

    try {
      while (state.logQueue.length > 0) {
        const item = state.logQueue[0];

        const payload = await jsonp({
          action: "log",
          id: item.id,
          plate: item.plate,
          ts: item.timestampMs,
        });

        if (!payload.ok) {
          throw new Error(payload.error || "Log failed.");
        }

        state.logQueue.shift();
        savePendingLogs();
      }
    } catch (err) {
      console.warn("Log pending:", err);
      updateLogStatus();
    } finally {
      state.logBusy = false;
    }
  }

  // ==========================================================
  // OCR MODEL
  // ==========================================================

  async function fetchBytes(url) {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`Model HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function loadModel() {
    if (!window.ort) {
      throw new Error("ONNX Runtime Web chưa load.");
    }

    ort.env.wasm.wasmPaths = CFG.ortWasmPath;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;

    const bytes = await fetchBytes(CFG.modelLocalUrl);

    state.modelSession =
      await ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });

    setOcrStatus("Ready");

    if (state.cameraReady && state.sourceReady) {
      setSystem("ready", "Sẵn sàng");
    }
  }

  async function initBodyWorker() {
    if (state.bodyReady) return state.bodyWorker;
    if (state.bodyInitPromise) return state.bodyInitPromise;

    state.bodyInitPromise = (async () => {
      if (!window.Tesseract) {
        throw new Error("Tesseract.js chưa load.");
      }

      const worker = await Tesseract.createWorker("eng", 1);

      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
        tessedit_char_whitelist:
          "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.",
        preserve_interword_spaces: "0",
        user_defined_dpi: "180",
      });

      state.bodyWorker = worker;
      state.bodyReady = true;
      return worker;
    })().catch((err) => {
      console.warn("Body OCR init:", err);
      throw err;
    });

    return state.bodyInitPromise;
  }

  function getVideoRoi() {
    const vw = els.video.videoWidth;
    const vh = els.video.videoHeight;

    if (!vw || !vh) throw new Error("Camera chưa có frame.");

    let w = vw * CFG.roiWidthRatio;
    let h = w / 2;

    const maxH = vh * CFG.roiMaxHeightRatio;

    if (h > maxH) {
      h = maxH;
      w = h * 2;
    }

    return {
      x: (vw - w) / 2,
      y: (vh - h) / 2,
      w,
      h,
    };
  }

  function drawRoi(canvas, boost = false) {
    const roi = getVideoRoi();
    const ctx =
      canvas.getContext("2d", { willReadFrequently: true });

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.filter =
      boost
        ? "grayscale(1) contrast(1.7) brightness(1.08)"
        : "none";

    ctx.drawImage(
      els.video,
      roi.x, roi.y, roi.w, roi.h,
      0, 0, canvas.width, canvas.height,
    );

    ctx.restore();
  }

  function canvasRgb(canvas) {
    const ctx =
      canvas.getContext("2d", { willReadFrequently: true });

    const rgba =
      ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    const rgb =
      new Uint8Array(canvas.width * canvas.height * 3);

    let j = 0;

    for (let i = 0; i < rgba.length; i += 4) {
      rgb[j++] = rgba[i];
      rgb[j++] = rgba[i + 1];
      rgb[j++] = rgba[i + 2];
    }

    return rgb;
  }

  function slotConfidence(values) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;

    for (const v of values) {
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }

    const looksLikeProb =
      min >= -0.0001 &&
      max <= 1.0001 &&
      Math.abs(sum - 1) < 0.08;

    if (looksLikeProb) return max;

    let denom = 0;
    for (const v of values) {
      denom += Math.exp(v - max);
    }

    return 1 / denom;
  }

  function decodeOutput(tensor) {
    const alphabet = CFG.model.alphabet;
    const vocab = alphabet.length;
    const slots = CFG.model.maxPlateSlots;
    const flat = tensor.data;

    let raw = "";
    const conf = [];

    for (let s = 0; s < slots; s++) {
      const offset = s * vocab;
      let bestIdx = 0;
      let bestVal = -Infinity;
      const slot = [];

      for (let i = 0; i < vocab; i++) {
        const v = Number(flat[offset + i]);
        slot.push(v);

        if (v > bestVal) {
          bestVal = v;
          bestIdx = i;
        }
      }

      raw += alphabet[bestIdx];
      conf.push(slotConfidence(slot));
    }

    raw = raw.replace(/_+$/g, "");
    const plate = extractPlate(raw);

    const n = Math.min(
      plate ? plate.length : raw.length,
      conf.length,
    );

    const confidence =
      n > 0
        ? conf.slice(0, n).reduce((a, b) => a + b, 0) / n
        : 0;

    return { raw, plate, confidence };
  }

  async function fastOcr() {
    drawRoi(els.modelCanvas, false);
    const rgb = canvasRgb(els.modelCanvas);

    const tensor =
      new ort.Tensor(
        "uint8",
        rgb,
        [
          1,
          CFG.model.height,
          CFG.model.width,
          CFG.model.channels,
        ],
      );

    const start = performance.now();

    const outputs =
      await state.modelSession.run({
        [CFG.model.inputName]: tensor,
      });

    const ms = performance.now() - start;

    const output =
      outputs[CFG.model.plateOutputName] ||
      outputs[Object.keys(outputs)[0]];

    const decoded = decodeOutput(output);

    state.lastOcrMs = ms;
    setOcrStatus(`${Math.round(ms)}ms`);

    return { ...decoded, ms };
  }

  async function bodyOcr() {
    if (state.bodyBusy) return null;

    state.bodyBusy = true;

    try {
      const worker = await initBodyWorker();

      drawRoi(els.bodyCanvas, true);

      const start = performance.now();

      const result =
        await worker.recognize(els.bodyCanvas);

      const ms = performance.now() - start;

      const text = result?.data?.text || "";
      const plate = extractPlate(text);
      const confidence =
        Math.max(
          0,
          Math.min(
            1,
            Number(result?.data?.confidence || 0) / 100,
          ),
        );

      return { plate, confidence, ms };
    } finally {
      state.bodyBusy = false;
    }
  }

  // ==========================================================
  // SCAN BUSINESS FLOW
  // ==========================================================

  function resetCandidate() {
    state.candidate = "";
    state.candidateCount = 0;
    state.candidateConfidence = 0;
  }

  function isDuplicate(plate) {
    return (
      plate === state.lastAcceptedPlate &&
      Date.now() - state.lastAcceptedAt <
        CFG.duplicateSuppressMs
    );
  }

  function lookupPlate(plate) {
    const item = state.sourceMap.get(plate);

    if (!item) {
      return {
        found: false,
        priority: CFG.notFoundPriority,
        blacklist: CFG.notFoundBlacklist,
      };
    }

    return {
      found: true,
      priority: item.priority,
      blacklist: item.blacklist,
    };
  }

  function acceptPlate(plate, engine, ms, options = {}) {
    if (!state.sourceReady) return;

    const force = Boolean(options.force);

    if (!force && isDuplicate(plate)) return;

    state.lastAcceptedPlate = plate;
    state.lastAcceptedAt = Date.now();

    state.paused = true;
    state.misses = 0;
    resetCandidate();

    const lookup = lookupPlate(plate);

    // EXACT requested output:
    // BKS - F - J
    const output =
      `${plate} - ${lookup.priority} - ${lookup.blacklist}`;

    setResult(
      lookup.found ? "known" : "unknown",
      output,
      engine === "MANUAL"
        ? "Nhập thủ công"
        : `${engine} · ${Math.round(ms)}ms`,
    );

    if (navigator.vibrate) {
      navigator.vibrate([70, 35, 70]);
    }

    // Background A/B logging.
    queueScanLog(plate, Date.now());

    setTimeout(() => {
      // Resume scanning but KEEP the last result visible.
      // The result is replaced only when the next BKS is accepted.
      state.paused = false;
    }, CFG.resultHoldMs);
  }

  function handleFast(result) {
    const plate = result.plate;

    if (!plate || !isValidPlate(plate)) {
      state.misses += 1;
      resetCandidate();
      return false;
    }

    if (isDuplicate(plate)) return true;

    if (plate === state.candidate) {
      state.candidateCount += 1;

      state.candidateConfidence =
        (
          state.candidateConfidence *
            (state.candidateCount - 1) +
          result.confidence
        ) / state.candidateCount;
    } else {
      state.candidate = plate;
      state.candidateCount = 1;
      state.candidateConfidence = result.confidence;
    }

    const stable =
      state.candidateCount >= CFG.stableRequired &&
      state.candidateConfidence >= CFG.minFastConfidence;

    const oneShot =
      result.confidence >= CFG.oneShotFastConfidence;

    if (stable || oneShot) {
      acceptPlate(
        plate,
        "FAST OCR",
        result.ms,
      );
    }

    return true;
  }

  async function maybeBodyFallback() {
    if (state.bodyBusy) return;

    const now = Date.now();

    if (
      state.misses < CFG.bodyFallbackAfterMisses ||
      now - state.lastBodyTick < CFG.bodyCooldownMs
    ) {
      return;
    }

    state.lastBodyTick = now;

    try {
      const result = await bodyOcr();

      if (
        result?.plate &&
        isValidPlate(result.plate) &&
        result.confidence >= CFG.bodyMinConfidence &&
        !isDuplicate(result.plate)
      ) {
        acceptPlate(
          result.plate,
          "BODY OCR",
          result.ms,
        );
      }
    } catch (err) {
      console.warn("Body OCR:", err);
    }
  }

  async function scanOnce() {
    if (
      state.fastBusy ||
      state.paused ||
      !state.running ||
      !state.modelSession ||
      !state.sourceReady
    ) {
      return;
    }

    state.fastBusy = true;

    try {
      const result = await fastOcr();
      const hadCandidate = handleFast(result);

      if (!hadCandidate) {
        void maybeBodyFallback();
      }
    } catch (err) {
      console.warn("Fast OCR:", err);
      state.misses += 1;
      void maybeBodyFallback();
    } finally {
      state.fastBusy = false;
    }
  }

  function loop(ts) {
    if (!state.running) return;

    requestAnimationFrame(loop);

    if (
      state.paused ||
      state.fastBusy ||
      ts - state.lastTick < CFG.scanIntervalMs
    ) {
      return;
    }

    state.lastTick = ts;
    void scanOnce();
  }

  // ==========================================================
  // CAMERA
  // ==========================================================

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Browser không hỗ trợ camera hoặc trang không chạy HTTPS.",
      );
    }

    state.stream?.getTracks().forEach(
      (track) => track.stop(),
    );

    const stream =
      await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });

    els.video.srcObject = stream;
    await els.video.play();

    state.stream = stream;
    state.cameraReady = true;
    state.running = true;

    els.cameraFallback.classList.add("hidden");

    if (state.modelSession && state.sourceReady) {
      setSystem("ready", "Sẵn sàng");
      setResult("idle", "Sẵn sàng quét", "Đưa BKS vào khung");
    }

    // General OCR warm-up in background.
    void initBodyWorker();

    requestAnimationFrame(loop);
  }

  function showCameraFallback(message) {
    els.cameraFallbackText.textContent =
      message || "Chạm để mở camera";
    els.cameraFallback.classList.remove("hidden");
  }

  // ==========================================================
  // MANUAL BKS FALLBACK
  // ==========================================================

  function submitManualPlate(rawValue) {
    if (!state.sourceReady) {
      setResult(
        "error",
        "SOURCE CHƯA SẴN SÀNG",
        "Chưa thể kiểm tra BKS thủ công.",
      );
      return;
    }

    const plate = normalizePlate(rawValue);

    if (!isValidPlate(plate)) {
      setResult(
        "error",
        "BKS KHÔNG HỢP LỆ",
        "Ví dụ hợp lệ: 50E36075 hoặc 50E-360.75",
      );

      return;
    }

    // Manual correction is intentional, so bypass short duplicate suppression.
    acceptPlate(
      plate,
      "MANUAL",
      0,
      { force: true },
    );

    els.manualInput.value = "";
    els.manualInput.blur();
  }

  els.manualForm.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      submitManualPlate(
        els.manualInput.value,
      );
    },
  );

  // ==========================================================
  // BOOT
  // ==========================================================

  async function boot() {
    loadPendingLogs();

    if (!backendConfigured()) {
      setSystem("error", "Chưa nối GSheet");
    } else {
      setSystem("loading", "Đang đồng bộ");
    }

    // Load model + source + camera concurrently.
    const modelPromise =
      loadModel().catch((err) => {
        console.error(err);
        setOcrStatus("ERROR");
        setSystem("error", "OCR lỗi");
        setResult(
          "error",
          "OCR MODEL ERROR",
          err?.message || String(err),
        );
        throw err;
      });

    const sourcePromise = refreshSource();

    // Auto camera: zero normal button flow.
    const cameraPromise =
      startCamera().catch((err) => {
        console.warn("Auto camera:", err);

        // Some mobile browsers require a user gesture.
        showCameraFallback("Chạm để mở camera");
        return false;
      });

    await Promise.allSettled([
      modelPromise,
      sourcePromise,
      cameraPromise,
    ]);

    if (
      state.modelSession &&
      state.sourceReady &&
      state.cameraReady
    ) {
      setSystem("ready", "Sẵn sàng");
      setResult("idle", "Sẵn sàng quét", "Đưa BKS vào khung");
    }

    // Refresh H/F/J without blocking scans.
    setInterval(() => {
      void refreshSource();
    }, CFG.sourceRefreshMs);

    // UI source age.
    setInterval(updateSourceStatus, 1000);

    // Retry unsent A/B logs.
    setInterval(() => {
      void flushLogQueue();
    }, 4000);

    void flushLogQueue();
  }

  els.cameraFallback.addEventListener(
    "click",
    async () => {
      try {
        els.cameraFallbackText.textContent =
          "Đang mở camera...";

        await startCamera();
      } catch (err) {
        els.cameraFallbackText.textContent =
          "Không mở được camera · chạm thử lại";

        setResult(
          "error",
          "CAMERA ERROR",
          err?.message || String(err),
        );
      }
    },
  );

  window.addEventListener("beforeunload", () => {
    try {
      state.stream
        ?.getTracks()
        .forEach((track) => track.stop());

      state.bodyWorker?.terminate();
    } catch (_) {}
  });

  boot();
})();
