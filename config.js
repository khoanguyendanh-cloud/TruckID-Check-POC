window.TRUCK_CHECK_CONFIG = Object.freeze({
  // Official FastPlateOCR release asset.
  // App tries local model first, then this official URL.
  modelLocalUrl: "./models/cct_xs_v2_global.onnx?v=2",
  modelRemoteUrl:
    "https://github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates/cct_xs_v2_global.onnx",

  ortWasmPath:
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",

  // cct_xs_v2_global_plate_config.yaml
  model: {
    inputName: "input",
    plateOutputName: "plate",
    height: 64,
    width: 128,
    channels: 3,
    maxPlateSlots: 10,
    alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_",
    padChar: "_",
  },

  // Scan tuning.
  scanIntervalMs: 420,
  stableRequired: 2,
  minFastConfidence: 0.53,
  oneShotFastConfidence: 0.90,
  duplicateSuppressMs: 4500,
  acceptedHoldMs: 950,

  // General body-text fallback.
  bodyFallbackAfterMisses: 5,
  bodyCooldownMs: 1700,
  bodyMinConfidence: 42,

  // ROI is always centered and exactly 2:1.
  roiWidthRatio: 0.86,
  roiMaxHeightRatio: 0.48,
});
