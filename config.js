window.TRUCK_CHECK_CONFIG = Object.freeze({
  // ==========================================================
  // PASTE APPS SCRIPT /exec URL HERE AFTER DEPLOY
  // Example:
  // https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxxx/exec
  // ==========================================================
  appsScriptUrl: "https://script.google.com/a/macros/spxexpress.com/s/AKfycbylXiEy1l8gAB3Ym0VGYBtyOxCURXuXn4N7CZGXP3pL6DKVPwNzZy2yEnb6jo87dZdz/exec?action=ping",
  
  modelLocalUrl: "./models/cct_xs_v2_global.onnx?v=2",

  ortWasmPath:
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",

  model: {
    inputName: "input",
    plateOutputName: "plate",
    height: 64,
    width: 128,
    channels: 3,
    maxPlateSlots: 10,
    alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_",
  },

  // Source H/F/J refresh.
  sourceRefreshMs: 30000,

  // Fast OCR.
  scanIntervalMs: 400,
  stableRequired: 2,
  minFastConfidence: 0.53,
  oneShotFastConfidence: 0.90,

  // Body BKS fallback.
  bodyFallbackAfterMisses: 5,
  bodyCooldownMs: 1600,
  bodyMinConfidence: 0.42,

  // UX.
  duplicateSuppressMs: 4500,
  resultHoldMs: 1200,

  // Centered 2:1 scan ROI.
  roiWidthRatio: 0.86,
  roiMaxHeightRatio: 0.48,

  // GSheet rule if BKS does not exist in H.
  notFoundPriority: "Không ưu tiên",
  notFoundBlacklist: "",

  // JSONP timeout.
  backendTimeoutMs: 7000,
});
