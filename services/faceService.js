const fs = require('fs');
const sharp = require('sharp');
const config = require('../config/config');

// ============================================================================
// InsightFace ("buffalo_l") face recognition pipeline
//
// Unlike a plain "resize the whole photo and embed it" approach, InsightFace
// is a two-stage pipeline:
//   1. DETECT — SCRFD finds the face's bounding box + 5 landmarks (eyes,
//      nose, mouth corners) in the source photo.
//   2. ALIGN + RECOGNIZE — those 5 landmarks are used to warp the face into
//      a canonical, upright 112x112 crop (the same alignment every
//      ArcFace-family model is trained on), which is then run through the
//      recognizer to produce the embedding.
// This is why InsightFace is meaningfully more accurate than embedding a
// naively-cropped photo: a tilted head, an off-center face, or a phone held
// at an angle all get corrected before recognition ever sees the image.
//
// Model files (see config/config.js for why these defaults / how to switch):
//   - Detector:   det_500m.onnx   (SCRFD-500M, "buffalo_s", bundled)
//   - Recognizer: w600k_mbf.onnx  (MobileFaceNet ArcFace, 512-d embeddings, "buffalo_s", bundled)
// ============================================================================

// Lazily loaded so the server can boot even before model files are in place
// (onnxruntime-node is a fairly heavy native dependency) and so we only pay
// the session-creation cost once per process.
let ort = null;

// ONNX Runtime's CPU memory arena keeps a large pool of scratch buffers
// around after each run; with both models loaded it pushed the process to
// ~430MB, over the 512MB limit of Render's free instance once the rest of
// the app is counted. Turning it off (and memory-pattern planning, which
// pre-reserves buffers the same way) brings both models down to ~260MB,
// with no measurable slowdown for single-image requests.
const SESSION_OPTIONS = { enableCpuMemArena: false, enableMemPattern: false };
let detectorSessionPromise = null;
let recognizerSessionPromise = null;

function getDetectorSession() {
  if (detectorSessionPromise) return detectorSessionPromise;
  detectorSessionPromise = (async () => {
    const modelPath = config.face.detectorModelPath;
    if (!fs.existsSync(modelPath)) {
      throw new Error(
        `InsightFace detector model not found at ${modelPath}. Download "det_10g.onnx" from the InsightFace ` +
        '"buffalo_l" model pack (https://github.com/deepinsight/insightface/tree/master/model_zoo) and place ' +
        'it there, or set FACE_DETECTOR_MODEL_PATH in .env to its location.'
      );
    }
    ort = ort || require('onnxruntime-node');
    return ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
  })();
  return detectorSessionPromise;
}

function getRecognizerSession() {
  if (recognizerSessionPromise) return recognizerSessionPromise;
  recognizerSessionPromise = (async () => {
    const modelPath = config.face.modelPath;
    if (!fs.existsSync(modelPath)) {
      throw new Error(
        `InsightFace recognizer model not found at ${modelPath}. Download "w600k_r50.onnx" from the InsightFace ` +
        '"buffalo_l" model pack (https://github.com/deepinsight/insightface/tree/master/model_zoo) and place ' +
        'it there, or set FACE_MODEL_PATH in .env to its location.'
      );
    }
    ort = ort || require('onnxruntime-node');
    return ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
  })();
  return recognizerSessionPromise;
}

// -- SCRFD detection --------------------------------------------------------

const FEAT_STRIDE_FPN = [8, 16, 32];
const NUM_ANCHORS = 2;

/**
 * Resizes the source photo to fit within detectorInputSize x detectorInputSize
 * (aspect-ratio preserved, placed at the top-left, zero-padded elsewhere) and
 * returns a normalized NCHW tensor -- this exact letterbox scheme (top-left,
 * not centered) mirrors InsightFace's own SCRFD preprocessing.
 */
async function preprocessDetectorInput(imagePath) {
  const inputSize = config.face.detectorInputSize;
  const meta = await sharp(imagePath).metadata();
  const origWidth = meta.width;
  const origHeight = meta.height;

  const imRatio = origHeight / origWidth;
  let newWidth;
  let newHeight;
  if (imRatio > 1) {
    newHeight = inputSize;
    newWidth = Math.max(1, Math.round(newHeight / imRatio));
  } else {
    newWidth = inputSize;
    newHeight = Math.max(1, Math.round(newWidth * imRatio));
  }
  const detScale = newHeight / origHeight; // == newWidth / origWidth

  const { data } = await sharp(imagePath)
    .resize(newWidth, newHeight, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = inputSize * inputSize;
  const chw = new Float32Array(pixelCount * 3); // zero-initialized -> black padding
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const srcIdx = (y * newWidth + x) * 3;
      const dstIdx = y * inputSize + x;
      chw[dstIdx] = (data[srcIdx] - 127.5) / 128.0;
      chw[pixelCount + dstIdx] = (data[srcIdx + 1] - 127.5) / 128.0;
      chw[pixelCount * 2 + dstIdx] = (data[srcIdx + 2] - 127.5) / 128.0;
    }
  }

  return { tensorData: chw, inputSize, detScale, origWidth, origHeight };
}

/**
 * Runs the SCRFD detector and decodes its raw per-stride outputs into
 * image-space boxes + 5-point landmark sets + scores (still in the padded
 * detector-input coordinate space -- callers rescale by detScale).
 */
async function runDetector(tensorData, inputSize) {
  const session = await getDetectorSession();
  const inputName = session.inputNames[0];
  const tensor = new ort.Tensor('float32', tensorData, [1, 3, inputSize, inputSize]);
  const results = await session.run({ [inputName]: tensor });

  // SCRFD's ONNX export groups outputs by TYPE across strides, not
  // interleaved per stride: [score_8, score_16, score_32, bbox_8, bbox_16,
  // bbox_32, (kps_8, kps_16, kps_32)] -- see insightface's scrfd.py forward().
  const names = session.outputNames;
  const fmc = FEAT_STRIDE_FPN.length; // 3
  const useKps = names.length >= fmc * 3;

  const boxes = [];
  const scores = [];
  const kpss = [];

  for (let idx = 0; idx < fmc; idx++) {
    const stride = FEAT_STRIDE_FPN[idx];
    const strideScores = results[names[idx]].data;
    const bboxPreds = results[names[idx + fmc]].data;
    const kpsPreds = useKps ? results[names[idx + fmc * 2]].data : null;

    const height = Math.floor(inputSize / stride);
    const width = Math.floor(inputSize / stride);

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        for (let a = 0; a < NUM_ANCHORS; a++) {
          const anchorIdx = (row * width + col) * NUM_ANCHORS + a;
          const score = strideScores[anchorIdx];
          if (score < config.face.detectorScoreThreshold) continue;

          const cx = col * stride;
          const cy = row * stride;

          const bOff = anchorIdx * 4;
          const dx1 = bboxPreds[bOff] * stride;
          const dy1 = bboxPreds[bOff + 1] * stride;
          const dx2 = bboxPreds[bOff + 2] * stride;
          const dy2 = bboxPreds[bOff + 3] * stride;
          boxes.push([cx - dx1, cy - dy1, cx + dx2, cy + dy2]);
          scores.push(score);

          if (useKps) {
            const kOff = anchorIdx * 10;
            const kps = [];
            for (let k = 0; k < 5; k++) {
              const px = cx + kpsPreds[kOff + k * 2] * stride;
              const py = cy + kpsPreds[kOff + k * 2 + 1] * stride;
              kps.push([px, py]);
            }
            kpss.push(kps);
          } else {
            kpss.push(null);
          }
        }
      }
    }
  }

  return { boxes, scores, kpss };
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Standard greedy IoU-based NMS, highest score first. */
function nms(boxes, scores, kpss, iouThreshold) {
  const order = scores.map((_, i) => i).sort((i, j) => scores[j] - scores[i]);
  const suppressed = new Array(boxes.length).fill(false);
  const kept = [];
  for (const i of order) {
    if (suppressed[i]) continue;
    kept.push({ box: boxes[i], score: scores[i], kps: kpss[i] });
    for (const j of order) {
      if (j === i || suppressed[j]) continue;
      if (iou(boxes[i], boxes[j]) > iouThreshold) suppressed[j] = true;
    }
  }
  return kept;
}

/**
 * Detects the most prominent face in a photo. Returns { score, box, kps }
 * (kps = 5 [x,y] landmark points, in ORIGINAL image coordinates) or null if
 * no face cleared the confidence threshold.
 */
async function detectFace(imagePath) {
  const { tensorData, inputSize, detScale } = await preprocessDetectorInput(imagePath);
  const { boxes, scores, kpss } = await runDetector(tensorData, inputSize);
  if (boxes.length === 0) return null;

  const detections = nms(boxes, scores, kpss, config.face.detectorNmsThreshold);
  if (detections.length === 0) return null;

  // If more than one face is in frame (e.g. someone walking by in the
  // background), prefer the largest -- almost certainly the one the camera
  // was actually pointed at.
  detections.sort((a, b) => {
    const areaA = (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]);
    const areaB = (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
    return areaB - areaA;
  });
  const best = detections[0];

  return {
    score: best.score,
    box: best.box.map((v) => v / detScale),
    kps: best.kps ? best.kps.map(([x, y]) => [x / detScale, y / detScale]) : null,
  };
}

// -- Alignment (5-point similarity transform -> canonical 112x112 crop) -----

// InsightFace's standard 112x112 alignment template: [left eye, right eye,
// nose tip, left mouth corner, right mouth corner]. Every ArcFace-family
// recognizer (including w600k_r50) is trained on faces aligned to these
// exact reference coordinates.
const ARCFACE_DST_112 = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Fits dst = s*R(theta)*src + t (uniform scale + rotation + translation, no
 * reflection) to N point correspondences by ordinary least squares. The
 * parametrization dst_x = a*src_x - b*src_y + tx; dst_y = b*src_x + a*src_y + ty
 * is LINEAR in (a, b, tx, ty), so a plain 4x4 normal-equations solve gives
 * the exact least-squares similarity transform without needing a general
 * SVD/Procrustes implementation.
 */
function solveSimilarityTransform(srcPts, dstPts) {
  const ATA = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const ATb = [0, 0, 0, 0];

  for (let i = 0; i < srcPts.length; i++) {
    const [sx, sy] = srcPts[i];
    const [dx, dy] = dstPts[i];
    const rowX = [sx, -sy, 1, 0]; // dst_x = a*sx - b*sy + tx
    const rowY = [sy, sx, 0, 1]; // dst_y = b*sx + a*sy + ty
    for (let r = 0; r < 4; r++) {
      ATb[r] += rowX[r] * dx + rowY[r] * dy;
      for (let c = 0; c < 4; c++) {
        ATA[r][c] += rowX[r] * rowX[c] + rowY[r] * rowY[c];
      }
    }
  }

  const [a, b, tx, ty] = solveLinearSystem(ATA, ATb);
  return { a, b, tx, ty };
}

/** Solves a small NxN linear system via Gaussian elimination with partial pivoting. */
function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) pivotRow = r;
    }
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

    const pivot = M[col][col] || 1e-9;
    for (let c = col; c <= n; c++) M[col][c] /= pivot;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }

  return M.map((row) => row[n]);
}

/**
 * Warps `src` (an interleaved RGB raw buffer, srcW x srcH x 3) into an
 * outW x outH aligned crop using the INVERSE of the fitted similarity
 * transform -- for every output pixel we look up where it came from in the
 * source and bilinearly sample, which (unlike forward/scatter mapping)
 * guarantees every output pixel gets filled.
 */
function warpAffine(src, srcW, srcH, transform, outW, outH) {
  const { a, b, tx, ty } = transform;
  const det = a * a + b * b || 1e-9;
  const out = new Uint8ClampedArray(outW * outH * 3); // defaults to black where the source doesn't cover

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const dx = ox - tx;
      const dy = oy - ty;
      // Inverse of the [[a,-b],[b,a]] rotation-scale block is (1/det)*[[a,b],[-b,a]].
      const sx = (a * dx + b * dy) / det;
      const sy = (-b * dx + a * dy) / det;
      if (sx < 0 || sy < 0 || sx > srcW - 1 || sy > srcH - 1) continue;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const fx = sx - x0;
      const fy = sy - y0;

      const outIdx = (oy * outW + ox) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = src[(y0 * srcW + x0) * 3 + ch];
        const p10 = src[(y0 * srcW + x1) * 3 + ch];
        const p01 = src[(y1 * srcW + x0) * 3 + ch];
        const p11 = src[(y1 * srcW + x1) * 3 + ch];
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        out[outIdx + ch] = top + (bottom - top) * fy;
      }
    }
  }
  return out;
}

/** Aligns the detected face to a canonical 112x112 RGB raw buffer. */
async function alignFace(imagePath, kps) {
  const { data, info } = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const transform = solveSimilarityTransform(kps, ARCFACE_DST_112);
  const inputSize = config.face.inputSize;
  return warpAffine(data, info.width, info.height, transform, inputSize, inputSize);
}

// -- Recognition (embedding) -------------------------------------------------

/** Runs the ArcFace recognizer on an already-aligned 112x112 RGB raw buffer. */
async function embedAlignedFace(rawRgbBuffer) {
  const session = await getRecognizerSession();
  const inputSize = config.face.inputSize;
  const pixelCount = inputSize * inputSize;
  const chw = new Float32Array(pixelCount * 3);
  // `rawRgbBuffer` is interleaved RGBRGBRGB...; the model wants planar RRR...GGG...BBB...
  for (let i = 0; i < pixelCount; i++) {
    chw[i] = (rawRgbBuffer[i * 3] - 127.5) / 128.0;
    chw[pixelCount + i] = (rawRgbBuffer[i * 3 + 1] - 127.5) / 128.0;
    chw[pixelCount * 2 + i] = (rawRgbBuffer[i * 3 + 2] - 127.5) / 128.0;
  }

  const inputName = session.inputNames[0];
  const tensor = new ort.Tensor('float32', chw, [1, 3, inputSize, inputSize]);
  const results = await session.run({ [inputName]: tensor });
  const outputName = session.outputNames[0];
  const raw = Array.from(results[outputName].data);

  // L2-normalize so cosine similarity reduces to a plain dot product.
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

/**
 * Full InsightFace pipeline: detect the face, align it to a canonical
 * 112x112 crop from its 5 landmarks, and return its L2-normalized embedding
 * (a plain array of numbers, ready to be JSON-stringified into
 * employee_faces.embedding). Throws a clear, user-facing message if no face
 * could be found, rather than silently embedding an uncropped/misaligned
 * photo the way a detection-less approach would.
 */
async function getEmbedding(imagePath) {
  // Phone cameras often save a portrait photo as landscape pixels plus an
  // EXIF orientation tag; without applying it the detector sees the face
  // sideways and misses it. Decode upright once and use that for both steps.
  const upright = await sharp(imagePath).rotate().toBuffer();
  const face = await detectFace(upright);
  if (!face || !face.kps) {
    throw new Error(
      'No face was detected in the photo. Please retake it with your face centered, unobstructed, and well-lit.'
    );
  }
  const aligned = await alignFace(upright, face.kps);
  return embedAlignedFace(aligned);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  // Both vectors are already L2-normalized by getEmbedding(), so the dot
  // product IS the cosine similarity (range -1..1).
  return dot;
}

/**
 * Compares one embedding against a list of { employeeId, embedding } candidates
 * and returns the best match (or null if nothing clears the configured threshold).
 */
function findBestMatch(targetEmbedding, candidates) {
  let best = null;
  for (const candidate of candidates) {
    const similarity = cosineSimilarity(targetEmbedding, candidate.embedding);
    if (!best || similarity > best.similarity) {
      best = { employeeId: candidate.employeeId, similarity };
    }
  }
  if (!best || best.similarity < config.face.matchThreshold) return null;
  return best;
}

// Loads both models ahead of the first request (called once the server is
// listening), so the first face registration or check-in after a deploy or
// cold start doesn't also pay the model-loading cost on a slow instance.
function warmUp() {
  return Promise.all([getDetectorSession(), getRecognizerSession()]);
}

module.exports = {
  getEmbedding,
  warmUp,
  detectFace,
  cosineSimilarity,
  findBestMatch,
  MODEL_PATH: config.face.modelPath,
  DETECTOR_MODEL_PATH: config.face.detectorModelPath,
  INPUT_SIZE: config.face.inputSize,
  // Exported purely so test/faceService.geometry.test.js can exercise the
  // pure-math pieces (no ONNX model required) without duplicating them.
  _internal: { solveSimilarityTransform, warpAffine, nms, iou },
};
