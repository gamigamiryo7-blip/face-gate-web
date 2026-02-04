// =====================
// 顔認証ゲート（Web版）
// 日本語UI / マスク登録 / 仮想人感（動体検知） / Arduino(任意)
// 成功時：同一ページで説明モーダル（ページ遷移しない）
// =====================

// ===== DOM取得 =====
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const statusText = document.getElementById("statusText");
const motionText = document.getElementById("motionText");

const nameInput = document.getElementById("nameInput");
const registerBtn = document.getElementById("registerBtn");
const registerMaskBtn = document.getElementById("registerMaskBtn");
const clearBtn = document.getElementById("clearBtn");
const armBtn = document.getElementById("armBtn");
const connectSerialBtn = document.getElementById("connectSerialBtn");

const gate = document.getElementById("gate");
const gateText = document.getElementById("gateText");
const lamp = document.getElementById("lamp");
const logList = document.getElementById("logList");

// ===== 説明モーダル =====
const aboutModal = document.getElementById("aboutModal");
const aboutUser = document.getElementById("aboutUser");
const aboutCountdown = document.getElementById("aboutCountdown");
const aboutCloseBtn = document.getElementById("aboutCloseBtn");

// ===== 設定 =====
const MODEL_URL =
  "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";

const ARM_WINDOW_MS = 4000;      // 動体検知後、認証を有効にする時間
const OPEN_HOLD_MS = 2000;       // ゲート開けておく時間
const MOTION_THRESHOLD = 12;     // 動体検知しきい値（環境で調整）
const MOTION_COOLDOWN_MS = 800;  // 動体検知連打防止
const MATCH_THRESHOLD = 0.50;    // 顔一致しきい値（小さいほど厳しい）

const ABOUT_MS = 6000;           // 説明モーダル表示時間

// 速くしたいなら inputSize を 160 にすると軽くなる（精度は少し下がる）
const DETECTOR_OPTS = new faceapi.TinyFaceDetectorOptions({
  inputSize: 224,
  scoreThreshold: 0.5,
});

// ===== 登録DB（localStorage） =====
const DB_KEY = "faceGateDB_v1";
function loadDB() {
  try { return JSON.parse(localStorage.getItem(DB_KEY) || "[]"); }
  catch { return []; }
}
function saveDB(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

// ===== 画面表示 =====
function setStatus(text) {
  statusText.textContent = text;
}

// ===== Arduino（Web Serial：任意） =====
let port = null;
let writer = null;

async function connectSerial() {
  if (!("serial" in navigator)) {
    alert("このブラウザはシリアル通信に未対応です。Chrome/Edgeで開いてね。");
    return;
  }
  if (!window.isSecureContext) {
    alert("シリアル通信は保護されたコンテキストが必要です。localhost で開いてね。");
    return;
  }

  port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });
  writer = port.writable.getWriter();
  setStatus("Arduino接続：OK（OPENを送れます）");
}

async function sendSerial(cmd) {
  if (!writer) return;
  const data = new TextEncoder().encode(cmd + "\n");
  await writer.write(data);
}

// ===== 状態 =====
let armedUntil = 0;
let lastMotionAt = 0;
let lastOpenedAt = 0;

function isArmed() {
  return Date.now() <= armedUntil;
}
function arm(ms = ARM_WINDOW_MS) {
  armedUntil = Date.now() + ms;
  setStatus("認証中（ARMED）…");
}

// ===== ピッ音（Web Audio） =====
let audioCtx = null;

async function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
}

async function beep(times = 2) {
  try {
    await ensureAudio();
    const now = audioCtx.currentTime;

    for (let i = 0; i < times; i++) {
      const t0 = now + i * 0.18;

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = "sine";
      osc.frequency.value = 880;

      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.15, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start(t0);
      osc.stop(t0 + 0.13);
    }
  } catch (e) {
    // 音がブロックされても無視でOK
    console.warn("beep blocked:", e);
  }
}

// ===== ランプ点滅 =====
function blinkLamp(ms = 600) {
  if (!lamp) return;
  lamp.classList.add("blink");
  setTimeout(() => lamp.classList.remove("blink"), ms);
}

// ===== ログ =====
function addLog(tag, msg) {
  if (!logList) return;
  const t = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  const li = document.createElement("li");
  li.innerHTML = `
    <span class="logTime">${t}</span>
    <span class="logTag">${tag}</span>
    <span class="logMsg">${msg}</span>
  `;
  logList.prepend(li);

  while (logList.children.length > 50) {
    logList.removeChild(logList.lastChild);
  }
}

// ===== 説明モーダル（同一ページ） =====
let aboutTimer = null;
let aboutTick = null;

function showAboutModal(userName, ms = ABOUT_MS) {
  if (!aboutModal) return;

  aboutModal.classList.add("show");
  aboutModal.setAttribute("aria-hidden", "false");

  if (aboutUser) aboutUser.textContent = `にんしょうしたひと：${userName || "-"}`;
  if (aboutCountdown) aboutCountdown.textContent = `あと ${Math.ceil(ms / 1000)} びょうでゲートにもどるよ…`;

  const start = Date.now();
  clearInterval(aboutTick);
  aboutTick = setInterval(() => {
    const left = Math.max(0, ms - (Date.now() - start));
    if (aboutCountdown) aboutCountdown.textContent = `あと ${Math.ceil(left / 1000)} びょうでゲートにもどるよ…`;
  }, 200);

  clearTimeout(aboutTimer);
  aboutTimer = setTimeout(() => {
    hideAboutModal();
  }, ms);
}

function hideAboutModal() {
  if (!aboutModal) return;
  aboutModal.classList.remove("show");
  aboutModal.setAttribute("aria-hidden", "true");

  clearTimeout(aboutTimer);
  clearInterval(aboutTick);
}

if (aboutCloseBtn) {
  aboutCloseBtn.addEventListener("click", hideAboutModal);
}

// ===== ゲートUI =====
function openGateUI(who = "") {
  gate.classList.add("open");
  gateText.textContent = who ? `開 (${who})` : "開";
  lastOpenedAt = Date.now();

  // 演出
  beep(2);
  blinkLamp(700);
  addLog("OPEN", `${who ? who : "不明"} が通過`);

  // ArduinoへOPEN（任意）
  sendSerial("OPEN").catch(() => {});
  addLog("SERIAL", writer ? "OPEN送信" : "（未接続）OPEN送信スキップ");

  setTimeout(() => {
    gate.classList.remove("open");
    gateText.textContent = "閉";
    setStatus("待機中（動きを検知すると認証開始）");
  }, OPEN_HOLD_MS);
}

// ===== 仮想人感（動体検知）用 =====
const mCanvas = document.createElement("canvas");
const mCtx = mCanvas.getContext("2d", { willReadFrequently: true });
let prevFrame = null;

// ===== カメラ起動 =====
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;

  await new Promise((res) => (video.onloadedmetadata = res));
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

  mCanvas.width = 160;
  mCanvas.height = 120;
}

// ===== face-api 初期化 =====
async function loadModels() {
  setStatus("モデル読み込み中…");
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
  setStatus("待機中（動きを検知すると認証開始）");
}

// ===== 登録（通常/マスク） =====
async function registerFace(tag = "通常") {
  const name = nameInput.value.trim();
  if (!name) return alert("登録名を入力してね。");

  arm(ARM_WINDOW_MS);

  const det = await faceapi
    .detectSingleFace(video, DETECTOR_OPTS)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!det) return alert("顔が検出できなかった…カメラ正面＆明るい場所で試して！");

  const db = loadDB();
  db.push({
    name,
    tag, // "通常" or "マスク"
    descriptor: Array.from(det.descriptor),
    createdAt: Date.now(),
  });
  saveDB(db);

  alert(`登録OK：${name}（${tag}）\n登録データ数：${db.length}`);
  setStatus("待機中（動きを検知すると認証開始）");
}

// ===== 認証（ARM中だけ） =====
function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

async function recognizeIfArmed() {
  if (!isArmed()) return;

  // OPEN直後の連打防止
  if (Date.now() - lastOpenedAt < 800) return;

  const db = loadDB();
  if (db.length === 0) return;

  const det = await faceapi
    .detectSingleFace(video, DETECTOR_OPTS)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!det) return;

  let best = { name: null, dist: Infinity };

  for (const item of db) {
    const dist = euclideanDistance(det.descriptor, new Float32Array(item.descriptor));
    if (dist < best.dist) best = { name: item.name, dist };
  }

  if (best.dist <= MATCH_THRESHOLD) {
    armedUntil = 0; // 次の動体検知まで待つ（1人ずつ）
    setStatus(`一致：${best.name}（OPEN）`);

    openGateUI(best.name);
    showAboutModal(best.name, ABOUT_MS);

    addLog("MATCH", `dist=${best.dist.toFixed(3)} / ${best.name}`);
  }
}

// ===== 仮想人感（動体検知） =====
function calcMotionScore() {
  mCtx.drawImage(video, 0, 0, mCanvas.width, mCanvas.height);
  const img = mCtx.getImageData(0, 0, mCanvas.width, mCanvas.height);

  const cur = new Uint8Array(mCanvas.width * mCanvas.height);
  for (let i = 0, p = 0; i < img.data.length; i += 4, p++) {
    cur[p] = (img.data[i] * 0.3 + img.data[i + 1] * 0.59 + img.data[i + 2] * 0.11) | 0;
  }

  if (!prevFrame) {
    prevFrame = cur;
    return 0;
  }

  let diffSum = 0;
  for (let i = 0; i < cur.length; i++) diffSum += Math.abs(cur[i] - prevFrame[i]);
  prevFrame = cur;

  return diffSum / cur.length;
}

async function tick() {
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const motion = calcMotionScore();
  if (motionText) motionText.textContent = `動き: ${motion.toFixed(1)}`;

  const now = Date.now();

  // 動体検知でARM
  if (!isArmed() && now - lastMotionAt > MOTION_COOLDOWN_MS) {
    if (motion >= MOTION_THRESHOLD) {
      lastMotionAt = now;
      arm(ARM_WINDOW_MS);
      addLog("MOTION", `ARM開始 motion=${motion.toFixed(1)}`);
    }
  }

  // ARM中だけ顔枠＆認証
  if (isArmed()) {
    const det = await faceapi.detectSingleFace(video, DETECTOR_OPTS);
    if (det) {
      const { x, y, width, height } = det.box;
      ctx.strokeStyle = "rgba(0,255,120,.9)";
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, width, height);
    }
    await recognizeIfArmed();
  }

  requestAnimationFrame(tick);
}

// ===== UIイベント（※1回だけ登録！） =====
registerBtn.addEventListener("click", async () => {
  await ensureAudio();
  registerFace("通常");
});

if (registerMaskBtn) {
  registerMaskBtn.addEventListener("click", async () => {
    await ensureAudio();
    registerFace("マスク");
  });
}

clearBtn.addEventListener("click", () => {
  if (confirm("登録データを全削除します。よろしいですか？")) {
    localStorage.removeItem(DB_KEY);
    alert("削除しました。");
    addLog("DB", "登録データ全削除");
    setStatus("待機中（動きを検知すると認証開始）");
  }
});

armBtn.addEventListener("click", async () => {
  await ensureAudio();
  arm(ARM_WINDOW_MS);
  addLog("ARM", "手動ARM");
});

connectSerialBtn.addEventListener("click", async () => {
  await ensureAudio();
  connectSerial();
});

// ===== 起動（initは1回だけ） =====
(async function init() {
  try {
    setStatus("カメラ起動中…");
    await startCamera();
    await loadModels();
    requestAnimationFrame(tick);
  } catch (e) {
    console.error(e);
    setStatus("エラー：F12→Consoleを確認");
    alert("起動エラー: " + (e?.message || e));
  }
})();
