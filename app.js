(() => {
  "use strict";

  const CFG = window.TRUCK_CHECK_CONFIG;
  const $ = (id) => document.getElementById(id);

  const els = {
    video: $("video"),
    cameraPlaceholder: $("cameraPlaceholder"),
    startBtn: $("startBtn"),
    forceBtn: $("forceBtn"),
    pauseBtn: $("pauseBtn"),

    modelStatus: $("modelStatus"),
    bodyStatus: $("bodyStatus"),
    runtimeStatus: $("runtimeStatus"),

    resultCard: $("resultCard"),
    resultPlate: $("resultPlate"),
    resultMeta: $("resultMeta"),

    candidateText: $("candidateText"),
    candidateConfidence: $("candidateConfidence"),
    candidateStable: $("candidateStable"),

    fastLast: $("fastLast"),
    fastP50: $("fastP50"),
    fastP95: $("fastP95"),
    bodyLast: $("bodyLast"),
    acceptedCount: $("acceptedCount"),
    missCount: $("missCount"),

    modelCanvas: $("modelCanvas"),
    bodyCanvas: $("bodyCanvas"),
    toast: $("toast"),
  };

  const state = {
    modelSession: null,
    modelSource: "",
    cameraStream: null,
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

    currentCandidate: "",
    currentCount: 0,
    currentConfidence: 0,

    lastAcceptedPlate: "",
    lastAcceptedAt: 0,
    acceptedCount: 0,

    fastLatencies: [],
    bodyLastMs: null,
  };

  function toast(message, ms = 2200) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => els.toast.classList.remove("show"), ms);
  }

  function setResult(kind, plate, meta) {
    els.resultCard.className = `result-card state-${kind}`;
    els.resultPlate.textContent = plate || "—";
    els.resultMeta.textContent = meta || "";
  }

  function setCandidate(plate = "—", confidence = null, count = 0) {
    els.candidateText.textContent = plate || "—";
    els.candidateConfidence.textContent =
      confidence == null ? "—" : `${Math.round(confidence * 100)}%`;
    els.candidateStable.textContent = `${count}/${CFG.stableRequired}`;
  }

  function normalizePlate(text) {
    return String(text || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  }

  function extractVietnamPlate(text) {
    const normalized = normalizePlate(text);
    const match = normalized.match(/\d{2}[A-Z]{1,2}\d{4,5}/);
    return match ? match[0] : "";
  }

  function isValidPlate(plate) {
    return /^\d{2}[A-Z]{1,2}\d{4,5}$/.test(normalizePlate(plate));
  }

  function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[idx];
  }

  function updateBench() {
    const last = state.fastLatencies.at(-1);
    const p50 = percentile(state.fastLatencies, 50);
    const p95 = percentile(state.fastLatencies, 95);

    els.fastLast.textContent = last == null ? "—" : `${last.toFixed(0)} ms`;
    els.fastP50.textContent = p50 == null ? "—" : `${p50.toFixed(0)} ms`;
    els.fastP95.textContent = p95 == null ? "—" : `${p95.toFixed(0)} ms`;
    els.bodyLast.textContent =
      state.bodyLastMs == null ? "—" : `${state.bodyLastMs.toFixed(0)} ms`;
    els.acceptedCount.textContent = String(state.acceptedCount);
    els.missCount.textContent = String(state.misses);
  }

  async function fetchBytes(url) {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} khi tải ${url}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function loadFastModel() {
    els.modelStatus.textContent = "Đang tải...";
    els.runtimeStatus.textContent = "WASM";

    if (!window.ort) {
      throw new Error("ONNX Runtime Web chưa load được.");
    }

    ort.env.wasm.wasmPaths = CFG.ortWasmPath;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;

    const candidates = [
      { label: "LOCAL", url: CFG.modelLocalUrl },
      { label: "OFFICIAL", url: CFG.modelRemoteUrl },
    ];

    const errors = [];

    for (const item of candidates) {
      try {
        const bytes = await fetchBytes(item.url);
        const started = performance.now();

        state.modelSession = await ort.InferenceSession.create(bytes, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });

        state.modelSource = item.label;
        const ms = performance.now() - started;
        els.modelStatus.textContent = `Ready · ${item.label}`;
        toast(`Fast OCR ready (${ms.toFixed(0)} ms init)`);
        return;
      } catch (err) {
        errors.push(`${item.label}: ${err?.message || err}`);
      }
    }

    throw new Error(
      `Không load được model.\n${errors.join("\n")}\n` +
        `Nếu official URL bị chặn/CORS, đặt cct_xs_v2_global.onnx vào folder /models.`,
    );
  }

  async function initBodyWorker() {
    if (state.bodyReady) return state.bodyWorker;
    if (state.bodyInitPromise) return state.bodyInitPromise;

    state.bodyInitPromise = (async () => {
      if (!window.Tesseract) {
        throw new Error("Tesseract.js chưa load được.");
      }

      els.bodyStatus.textContent = "Đang warm-up...";

      const worker = await Tesseract.createWorker("eng", 1, {
        logger: (m) => {
          if (m?.status === "recognizing text") return;
          if (m?.status && typeof m.progress === "number") {
            els.bodyStatus.textContent =
              `${m.status} ${Math.round(m.progress * 100)}%`;
          }
        },
      });

      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
        tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.",
        preserve_interword_spaces: "0",
        user_defined_dpi: "180",
      });

      state.bodyWorker = worker;
      state.bodyReady = true;
      els.bodyStatus.textContent = "Ready";
      return worker;
    })().catch((err) => {
      state.bodyReady = false;
      els.bodyStatus.textContent = "Fallback lỗi";
      console.warn("Body OCR init failed:", err);
      throw err;
    });

    return state.bodyInitPromise;
  }

  function getVideoRoi() {
    const vw = els.video.videoWidth;
    const vh = els.video.videoHeight;

    if (!vw || !vh) {
      throw new Error("Camera chưa có frame.");
    }

    let w = vw * CFG.roiWidthRatio;
    let h = w / 2;

    const maxH = vh * CFG.roiMaxHeightRatio;
    if (h > maxH) {
      h = maxH;
      w = h * 2;
    }

    const x = (vw - w) / 2;
    const y = (vh - h) / 2;

    return { x, y, w, h };
  }

  function drawRoi(canvas, { grayscaleBoost = false } = {}) {
    const { x, y, w, h } = getVideoRoi();
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (grayscaleBoost) {
      ctx.filter = "grayscale(1) contrast(1.65) brightness(1.08)";
    } else {
      ctx.filter = "none";
    }

    ctx.drawImage(
      els.video,
      x, y, w, h,
      0, 0, canvas.width, canvas.height,
    );

    ctx.restore();
    return ctx;
  }

  function canvasToRgbUint8(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const rgb = new Uint8Array(canvas.width * canvas.height * 3);

    let j = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      rgb[j++] = rgba[i];
      rgb[j++] = rgba[i + 1];
      rgb[j++] = rgba[i + 2];
    }
    return rgb;
  }

  function slotConfidence(slot) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;

    for (const v of slot) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }

    // If output already looks like probabilities, use it directly.
    const looksProb =
      min >= -0.0001 &&
      max <= 1.0001 &&
      Math.abs(sum - 1) < 0.08;

    if (looksProb) {
      return max;
    }

    // Otherwise compute softmax max probability.
    let denom = 0;
    for (const v of slot) denom += Math.exp(v - max);
    return 1 / denom;
  }

  function decodePlateTensor(tensor) {
    const alphabet = CFG.model.alphabet;
    const slots = CFG.model.maxPlateSlots;
    const vocab = alphabet.length;
    const flat = tensor.data;

    if (flat.length < slots * vocab) {
      throw new Error(
        `Plate output quá ngắn: ${flat.length}, expected >= ${slots * vocab}`,
      );
    }

    let text = "";
    const charConfidence = [];

    for (let s = 0; s < slots; s++) {
      const offset = s * vocab;

      let bestIdx = 0;
      let bestVal = -Infinity;

      for (let i = 0; i < vocab; i++) {
        const value = Number(flat[offset + i]);
        if (value > bestVal) {
          bestVal = value;
          bestIdx = i;
        }
      }

      const slot = [];
      for (let i = 0; i < vocab; i++) {
        slot.push(Number(flat[offset + i]));
      }

      text += alphabet[bestIdx];
      charConfidence.push(slotConfidence(slot));
    }

    text = text.replace(/_+$/g, "");
    const plate = extractVietnamPlate(text);

    const usedChars = Math.min(
      plate ? plate.length : text.replace(/_+$/g, "").length,
      charConfidence.length,
    );

    const confidence =
      usedChars > 0
        ? charConfidence.slice(0, usedChars).reduce((a, b) => a + b, 0) /
          usedChars
        : 0;

    return {
      raw: text,
      plate,
      confidence,
      charConfidence,
    };
  }

  async function runFastOcr() {
    if (!state.modelSession) {
      throw new Error("Fast OCR model chưa ready.");
    }

    drawRoi(els.modelCanvas);
    const rgb = canvasToRgbUint8(els.modelCanvas);

    const tensor = new ort.Tensor(
      "uint8",
      rgb,
      [1, CFG.model.height, CFG.model.width, CFG.model.channels],
    );

    const started = performance.now();
    const outputs = await state.modelSession.run({
      [CFG.model.inputName]: tensor,
    });
    const ms = performance.now() - started;

    state.fastLatencies.push(ms);
    if (state.fastLatencies.length > 100) state.fastLatencies.shift();

    const output =
      outputs[CFG.model.plateOutputName] ||
      outputs[Object.keys(outputs)[0]];

    if (!output) throw new Error("Model không trả output plate.");

    const decoded = decodePlateTensor(output);
    decoded.ms = ms;
    updateBench();
    return decoded;
  }

  async function runBodyOcr() {
    if (state.bodyBusy) return null;

    state.bodyBusy = true;
    try {
      const worker = await initBodyWorker();
      drawRoi(els.bodyCanvas, { grayscaleBoost: true });

      const started = performance.now();
      const result = await worker.recognize(els.bodyCanvas);
      const ms = performance.now() - started;
      state.bodyLastMs = ms;
      updateBench();

      const rawText = result?.data?.text || "";
      const confidence = Number(result?.data?.confidence || 0);
      const plate = extractVietnamPlate(rawText);

      return {
        raw: rawText,
        plate,
        confidence: Math.max(0, Math.min(1, confidence / 100)),
        ms,
      };
    } finally {
      state.bodyBusy = false;
    }
  }

  function resetStability() {
    state.currentCandidate = "";
    state.currentCount = 0;
    state.currentConfidence = 0;
    setCandidate();
  }

  function canAcceptPlate(plate) {
    const now = performance.now();
    return !(
      plate === state.lastAcceptedPlate &&
      now - state.lastAcceptedAt < CFG.duplicateSuppressMs
    );
  }

  function acceptPlate(plate, engine, confidence, ms) {
    if (!canAcceptPlate(plate)) return;

    state.lastAcceptedPlate = plate;
    state.lastAcceptedAt = performance.now();
    state.acceptedCount += 1;

    state.paused = true;
    state.misses = 0;
    resetStability();
    updateBench();

    const confText = Number.isFinite(confidence)
      ? `${Math.round(confidence * 100)}%`
      : "—";

    setResult(
      "success",
      plate,
      `${engine} · conf ${confText} · ${ms.toFixed(0)} ms`,
    );

    if (navigator.vibrate) navigator.vibrate([70, 40, 70]);

    setTimeout(() => {
      if (!state.running) return;
      state.paused = false;
      setResult(
        "idle",
        "—",
        "Sẵn sàng xe tiếp theo · auto-scan đang chạy",
      );
    }, CFG.acceptedHoldMs);
  }

  function handleFastCandidate(result) {
    const plate = result.plate;
    const confidence = result.confidence;

    if (!plate || !isValidPlate(plate)) {
      state.misses += 1;
      resetStability();
      updateBench();
      return false;
    }

    if (!canAcceptPlate(plate)) return true;

    if (plate === state.currentCandidate) {
      state.currentCount += 1;
      state.currentConfidence =
        (state.currentConfidence * (state.currentCount - 1) + confidence) /
        state.currentCount;
    } else {
      state.currentCandidate = plate;
      state.currentCount = 1;
      state.currentConfidence = confidence;
    }

    setCandidate(
      state.currentCandidate,
      state.currentConfidence,
      state.currentCount,
    );

    const stableEnough =
      state.currentCount >= CFG.stableRequired &&
      state.currentConfidence >= CFG.minFastConfidence;

    const oneShot =
      confidence >= CFG.oneShotFastConfidence;

    if (stableEnough || oneShot) {
      acceptPlate(
        plate,
        "FAST PLATE OCR",
        state.currentConfidence,
        result.ms,
      );
      return true;
    }

    return true;
  }

  async function maybeRunBodyFallback(force = false) {
    const now = performance.now();

    if (!force && state.misses < CFG.bodyFallbackAfterMisses) return;
    if (!force && now - state.lastBodyTick < CFG.bodyCooldownMs) return;
    if (state.bodyBusy) return;

    state.lastBodyTick = now;

    try {
      const body = await runBodyOcr();
      if (!body) return;

      const valid =
        body.plate &&
        isValidPlate(body.plate) &&
        body.confidence >= CFG.bodyMinConfidence / 100;

      if (valid && canAcceptPlate(body.plate)) {
        acceptPlate(
          body.plate,
          "BODY OCR",
          body.confidence,
          body.ms,
        );
        state.misses = 0;
      }
    } catch (err) {
      console.warn("Body OCR fallback:", err);
    }
  }

  async function scanOnce({ forceBody = false } = {}) {
    if (state.fastBusy || state.paused || !state.running) return;

    state.fastBusy = true;
    try {
      const result = await runFastOcr();
      const hadCandidate = handleFastCandidate(result);

      if (!hadCandidate || forceBody) {
        void maybeRunBodyFallback(forceBody);
      } else if (state.misses >= CFG.bodyFallbackAfterMisses) {
        void maybeRunBodyFallback(false);
      }
    } catch (err) {
      console.error("Fast OCR:", err);
      state.misses += 1;
      updateBench();
      void maybeRunBodyFallback(false);
    } finally {
      state.fastBusy = false;
    }
  }

  function scanLoop(timestamp) {
    if (!state.running) return;

    requestAnimationFrame(scanLoop);

    if (state.paused || state.fastBusy) return;
    if (timestamp - state.lastTick < CFG.scanIntervalMs) return;

    state.lastTick = timestamp;
    void scanOnce();
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Browser không cho truy cập camera. Hãy mở web bằng HTTPS trên Chrome/Safari hiện đại.",
      );
    }

    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => track.stop());
      state.cameraStream = null;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });

    els.video.srcObject = stream;
    await els.video.play();

    state.cameraStream = stream;
    state.running = true;
    state.paused = false;
    state.misses = 0;

    els.cameraPlaceholder.style.display = "none";
    els.startBtn.textContent = "Camera đang bật";
    els.startBtn.disabled = true;
    els.forceBtn.disabled = false;
    els.pauseBtn.disabled = false;
    els.pauseBtn.textContent = "Tạm dừng";

    setResult(
      "idle",
      "—",
      "Auto-scan đang chạy · đưa BKS vào khung",
    );

    // Warm-up general OCR in background.
    void initBodyWorker();

    state.lastTick = 0;
    requestAnimationFrame(scanLoop);
  }

  function togglePause() {
    if (!state.running) return;

    state.paused = !state.paused;
    els.pauseBtn.textContent = state.paused ? "Tiếp tục" : "Tạm dừng";

    if (state.paused) {
      setResult("warning", "PAUSE", "Đã tạm dừng auto-scan");
    } else {
      setResult("idle", "—", "Auto-scan đang chạy");
    }
  }

  async function forceScan() {
    if (!state.running) return;

    const wasPaused = state.paused;
    state.paused = false;

    try {
      els.forceBtn.disabled = true;
      toast("Đang quét cưỡng bức...");
      await scanOnce({ forceBody: true });
    } finally {
      state.paused = wasPaused;
      els.forceBtn.disabled = false;
    }
  }

  async function boot() {
    setResult("idle", "—", "Đang load OCR model...");

    els.startBtn.addEventListener("click", async () => {
      try {
        els.startBtn.disabled = true;
        els.startBtn.textContent = "Đang mở camera...";
        await startCamera();
      } catch (err) {
        console.error(err);
        els.startBtn.disabled = false;
        els.startBtn.textContent = "Thử lại camera";
        setResult("error", "CAMERA ERROR", err?.message || String(err));
        toast("Không mở được camera.");
      }
    });

    els.pauseBtn.addEventListener("click", togglePause);
    els.forceBtn.addEventListener("click", forceScan);

    try {
      await loadFastModel();
      setResult(
        "idle",
        "—",
        "Model ready · bấm Bật camera để bắt đầu",
      );
      els.startBtn.disabled = false;
    } catch (err) {
      console.error(err);
      els.modelStatus.textContent = "LOAD ERROR";
      setResult(
        "error",
        "MODEL ERROR",
        err?.message || String(err),
      );
      els.startBtn.disabled = true;
    }

    updateBench();
  }

  window.addEventListener("beforeunload", () => {
    try {
      state.cameraStream?.getTracks().forEach((track) => track.stop());
      state.bodyWorker?.terminate();
    } catch (_) {
      // best effort only
    }
  });

  boot();
})();
