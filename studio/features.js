// features.js
// 画像 → 42特徴量 抽出モジュール
// 依存なし（pure browser JS）
// 公開: window.extractFeatures(imageElement) → Features オブジェクト
//
// 出力仕様（42 値、全て 0-1 正規化済み）:
//   [基本5]
//     brightness, saturation, edge_density, hue_mean, hue_variance
//   [Tier 1: 空間構造 +13]
//     block_brightness[9], block_edge_density[9]
//     brightness_vertical_diff, brightness_horizontal_diff, brightness_diagonal_diff
//     ※ブロック系は9要素×2で18だが配列なのでトップキーは2本
//   [Tier 2: 色の多様性 +15]
//     hue_histogram[12], hue_concentration, saturation_variance, brightness_variance
//   [Tier 3: テクスチャ +5]
//     edge_direction[4], local_contrast
//   [Tier 4: 高次統計 +3]
//     saturation_brightness_correlation, hue_entropy, brightness_skewness

(function(global) {

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function extractFeatures(img) {
  // ---- ラスタライズ ----
  const maxSide = 200;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.max(3, Math.floor((img.naturalWidth || img.width) * scale));
  const h = Math.max(3, Math.floor((img.naturalHeight || img.height) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  // ---- 基本集計（1パス） ----
  // 輝度 / 彩度 / 色相 + 9ブロック輝度 + 色相ヒスト + 輝度・彩度サンプル配列（分散/相関/歪度用）
  const step = 2;
  let sumV = 0, sumS = 0;
  let count = 0;
  const hues = [];
  const blockV = new Array(9).fill(0);
  const blockCount = new Array(9).fill(0);
  const hueHist = new Array(12).fill(0);
  let hueHistCount = 0;
  const vSamples = [];
  const sSamples = [];
  const third_w = w / 3, third_h = h / 3;

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const idx = (y * w + x) * 4;
      const r = data[idx] / 255;
      const g = data[idx + 1] / 255;
      const b = data[idx + 2] / 255;
      const hsv = rgbToHsv(r, g, b);
      sumV += hsv.v;
      sumS += hsv.s;
      vSamples.push(hsv.v);
      sSamples.push(hsv.s);
      // ブロック
      const bx = Math.min(2, Math.floor(x / third_w));
      const by = Math.min(2, Math.floor(y / third_h));
      const bi = by * 3 + bx;
      blockV[bi] += hsv.v;
      blockCount[bi]++;
      // 色相（彩度 > 0.1 のみ）
      if (hsv.s > 0.1) {
        hues.push(hsv.h);
        const binIdx = Math.min(11, Math.floor(hsv.h * 12));
        hueHist[binIdx]++;
        hueHistCount++;
      }
      count++;
    }
  }

  const brightness = sumV / Math.max(1, count);
  const saturation = sumS / Math.max(1, count);

  // ブロック平均
  const block_brightness = blockV.map((v, i) => v / Math.max(1, blockCount[i]));

  // ---- 色相の環状平均・集中度 ----
  let hue_mean = 0, hue_var = 0, hue_concentration = 0;
  if (hues.length > 0) {
    let sumSin = 0, sumCos = 0;
    for (const hv of hues) {
      const rad = hv * 2 * Math.PI;
      sumSin += Math.sin(rad);
      sumCos += Math.cos(rad);
    }
    const meanRad = Math.atan2(sumSin / hues.length, sumCos / hues.length);
    hue_mean = (meanRad / (2 * Math.PI) + 1) % 1;
    const R = Math.sqrt((sumSin / hues.length) ** 2 + (sumCos / hues.length) ** 2);
    hue_var = 1 - R;
    hue_concentration = R;
  }

  // ---- 色相ヒストグラム正規化 ----
  const hue_histogram = hueHistCount > 0
    ? hueHist.map(v => v / hueHistCount)
    : new Array(12).fill(0);

  // ---- 色相エントロピー（Shannon, 正規化） ----
  let hue_entropy = 0;
  for (const p of hue_histogram) {
    if (p > 0) hue_entropy -= p * Math.log2(p);
  }
  hue_entropy /= Math.log2(12); // 0-1 に正規化

  // ---- グレースケールマップ + エッジ ----
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      gray[y * w + x] = (data[idx] + data[idx + 1] + data[idx + 2]) / (3 * 255);
    }
  }

  // エッジ密度 + 方向ヒスト + ブロック別エッジ密度 + 局所コントラスト
  const threshold = 0.1;
  let edgeCount = 0;
  const edgeDirBins = [0, 0, 0, 0]; // 水平(0), 斜め↑(1), 垂直(2), 斜め↓(3)
  const blockEdge = new Array(9).fill(0);
  const blockPix = new Array(9).fill(0);
  let contrastSum = 0;
  let contrastCount = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = -gray[(y - 1) * w + (x - 1)] - 2 * gray[y * w + (x - 1)] - gray[(y + 1) * w + (x - 1)]
               + gray[(y - 1) * w + (x + 1)] + 2 * gray[y * w + (x + 1)] + gray[(y + 1) * w + (x + 1)];
      const gy = -gray[(y - 1) * w + (x - 1)] - 2 * gray[(y - 1) * w + x] - gray[(y - 1) * w + (x + 1)]
               + gray[(y + 1) * w + (x - 1)] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + (x + 1)];
      const mag = Math.sqrt(gx * gx + gy * gy);
      const bx = Math.min(2, Math.floor(x / third_w));
      const by = Math.min(2, Math.floor(y / third_h));
      const bi = by * 3 + bx;
      blockPix[bi]++;
      if (mag > threshold) {
        edgeCount++;
        blockEdge[bi]++;
        // 方向分類（atan2 結果 -PI..PI → 0..PI の4分類）
        let angle = Math.atan2(gy, gx);
        if (angle < 0) angle += Math.PI; // 0..PI
        const dirBin = Math.min(3, Math.floor(angle / (Math.PI / 4)));
        edgeDirBins[dirBin]++;
      }
      // 局所コントラスト（中央と周囲8画素の平均絶対差）
      const c = gray[y * w + x];
      const neighbors = [
        gray[(y - 1) * w + (x - 1)], gray[(y - 1) * w + x], gray[(y - 1) * w + (x + 1)],
        gray[y * w + (x - 1)],                              gray[y * w + (x + 1)],
        gray[(y + 1) * w + (x - 1)], gray[(y + 1) * w + x], gray[(y + 1) * w + (x + 1)],
      ];
      let diff = 0;
      for (const n of neighbors) diff += Math.abs(n - c);
      contrastSum += diff / 8;
      contrastCount++;
    }
  }

  const totalEdgePixels = (w - 2) * (h - 2);
  const edge_density = edgeCount / Math.max(1, totalEdgePixels);
  const block_edge_density = blockEdge.map((v, i) => v / Math.max(1, blockPix[i]));
  const edge_direction = edgeDirBins.map(v => v / Math.max(1, edgeCount));
  const local_contrast = clamp01(contrastSum / Math.max(1, contrastCount) * 2); // ×2 で可視領域に寄せる

  // ---- 空間差分（上下/左右/対角） ----
  // block_brightness: [TL, TC, TR, ML, MC, MR, BL, BC, BR] = [0..8]
  const topMean = (block_brightness[0] + block_brightness[1] + block_brightness[2]) / 3;
  const botMean = (block_brightness[6] + block_brightness[7] + block_brightness[8]) / 3;
  const leftMean = (block_brightness[0] + block_brightness[3] + block_brightness[6]) / 3;
  const rightMean = (block_brightness[2] + block_brightness[5] + block_brightness[8]) / 3;
  const diagTLBR = (block_brightness[0] + block_brightness[8]) / 2;
  const diagTRBL = (block_brightness[2] + block_brightness[6]) / 2;
  const brightness_vertical_diff = (topMean - botMean + 1) / 2;     // -1..1 → 0..1
  const brightness_horizontal_diff = (leftMean - rightMean + 1) / 2;
  const brightness_diagonal_diff = (diagTLBR - diagTRBL + 1) / 2;

  // ---- 分散（輝度・彩度） ----
  function variance(arr, mean) {
    let s = 0;
    for (const v of arr) s += (v - mean) ** 2;
    return s / Math.max(1, arr.length);
  }
  const brightness_variance = clamp01(variance(vSamples, brightness) * 4); // 視覚領域へ寄せる
  const saturation_variance = clamp01(variance(sSamples, saturation) * 4);

  // ---- 輝度の歪度（Fisher skewness） ----
  // skew = E[(X-μ)^3] / σ^3
  let skewNum = 0;
  const vVar = variance(vSamples, brightness);
  const vStd = Math.sqrt(Math.max(1e-9, vVar));
  for (const v of vSamples) skewNum += (v - brightness) ** 3;
  const skewRaw = (skewNum / Math.max(1, vSamples.length)) / (vStd ** 3);
  const brightness_skewness = clamp01((skewRaw + 3) / 6); // 約 -3..3 → 0..1

  // ---- 彩度-輝度相関（Pearson） ----
  let covar = 0;
  for (let i = 0; i < vSamples.length; i++) {
    covar += (vSamples[i] - brightness) * (sSamples[i] - saturation);
  }
  covar /= Math.max(1, vSamples.length);
  const sVar = variance(sSamples, saturation);
  const pearson = covar / Math.max(1e-9, Math.sqrt(vVar * sVar));
  const saturation_brightness_correlation = (clamp01((pearson + 1) / 2)); // -1..1 → 0..1

  return {
    // 基本
    brightness: clamp01(brightness),
    saturation: clamp01(saturation),
    edge_density: clamp01(edge_density),
    hue_mean: clamp01(hue_mean),
    hue_variance: clamp01(hue_var),
    // Tier 1
    block_brightness: block_brightness.map(clamp01),
    block_edge_density: block_edge_density.map(clamp01),
    brightness_vertical_diff: clamp01(brightness_vertical_diff),
    brightness_horizontal_diff: clamp01(brightness_horizontal_diff),
    brightness_diagonal_diff: clamp01(brightness_diagonal_diff),
    // Tier 2
    hue_histogram,
    hue_concentration: clamp01(hue_concentration),
    saturation_variance,
    brightness_variance,
    // Tier 3
    edge_direction,
    local_contrast,
    // Tier 4
    saturation_brightness_correlation,
    hue_entropy: clamp01(hue_entropy),
    brightness_skewness,
  };
}

// 公開
global.extractFeatures = extractFeatures;
global.rgbToHsv = rgbToHsv; // 後方互換

})(window);
