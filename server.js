/**
 * YDM Bingo — Backend Game Runner
 * ════════════════════════════════════════════════════════════════
 * Run this on your server (VPS / Railway / Render / any Node host).
 * It owns ALL number drawing — no browser host, no lag, no races.
 *
 * Usage:
 *   node game-runner.js
 *
 * Required env vars (or edit CONFIG below):
 *   FIREBASE_PROJECT_ID   — your Firebase project id
 *   FIREBASE_DB_URL       — e.g. https://ydm-bingo-realtime-default-rtdb.firebaseio.com
 *   GOOGLE_APPLICATION_CREDENTIALS — path to your serviceAccountKey.json
 *
 * Deployment examples:
 *   • Railway / Render: add the env vars in the dashboard, upload this file + package.json
 *   • VPS:  pm2 start game-runner.js --name ydm-bingo
 * ════════════════════════════════════════════════════════════════
 */

const admin = require("firebase-admin");

// ── CONFIG ────────────────────────────────────────────────────────
const CONFIG = {
  projectId : process.env.FIREBASE_PROJECT_ID  || "ydm-bingo-realtime",
  databaseURL: process.env.FIREBASE_DB_URL      || "https://ydm-bingo-realtime-default-rtdb.firebaseio.com",
  drawIntervalMs : 3000,   // ms between drawn numbers (3 s)
  winCollectMs   : 2500,   // ms to wait after first winner before closing game
  minPlayers     : 2,      // minimum players needed to start
  maxNumbers     : 75,
};

// ── FIREBASE INIT ────────────────────────────────────────────────
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (credPath) {
  admin.initializeApp({
    credential   : admin.credential.cert(require(credPath)),
    databaseURL  : CONFIG.databaseURL,
  });
} else {
  // Fallback: applicationDefault (works on GCP / Cloud Functions automatically)
  admin.initializeApp({
    credential   : admin.credential.applicationDefault(),
    databaseURL  : CONFIG.databaseURL,
  });
}
const db = admin.database();

// ── BINGO PATTERNS ───────────────────────────────────────────────
const PATTERNS = [
  { n: "Row 1",    i: [0,1,2,3,4] },
  { n: "Row 2",    i: [5,6,7,8,9] },
  { n: "Row 3",    i: [10,11,12,13,14] },
  { n: "Row 4",    i: [15,16,17,18,19] },
  { n: "Row 5",    i: [20,21,22,23,24] },
  { n: "Col B",    i: [0,5,10,15,20] },
  { n: "Col I",    i: [1,6,11,16,21] },
  { n: "Col N",    i: [2,7,12,17,22] },
  { n: "Col G",    i: [3,8,13,18,23] },
  { n: "Col O",    i: [4,9,14,19,24] },
  { n: "Diag \\",  i: [0,6,12,18,24] },
  { n: "Diag /",   i: [4,8,12,16,20] },
  { n: "4 Corners",i: [0,4,20,24] },
  { n: "T-shape",  i: [0,1,2,3,4,7,12,17,22] },
  { n: "L-shape",  i: [0,5,10,15,20,21,22,23,24] },
  { n: "Full Card", i: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24] },
];

// ── HELPERS ──────────────────────────────────────────────────────
function letter(n) { return n<=15?"B":n<=30?"I":n<=45?"N":n<=60?"G":"O"; }
function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

// ── GAME STATE ───────────────────────────────────────────────────
let drawn         = [];
let drawTimer     = null;
let winCollectTimer = null;
let gameRunning   = false;

// ── REGISTER AS BACKEND RUNNER ───────────────────────────────────
// Write a runner heartbeat so the frontend knows numbers come from backend.
async function registerRunner() {
  await db.ref("activeGame/runner").set({
    pid    : process.pid,
    startedAt : admin.database.ServerValue.TIMESTAMP,
    status : "active",
  });
  // Remove on exit
  await db.ref("activeGame/runner").onDisconnect().remove();
  log("Runner registered (pid", process.pid + ")");
}

// ── DRAW ONE NUMBER ──────────────────────────────────────────────
async function drawNumber() {
  // Re-read drawn numbers from DB (authoritative source, avoids drift)
  const snap = await db.ref("activeGame/drawnNumbers").once("value");
  const serverDrawn = new Set();
  if (snap.exists()) snap.forEach(c => { if (c.val()?.number) serverDrawn.add(c.val().number); });

  // Merge with local cache
  serverDrawn.forEach(n => { if (!drawn.includes(n)) drawn.push(n); });

  if (drawn.length >= CONFIG.maxNumbers) {
    log("All 75 numbers drawn — ending game (no winner)");
    await endGame(null);
    return;
  }

  // Pick random available number
  const available = [];
  for (let i = 1; i <= CONFIG.maxNumbers; i++) if (!serverDrawn.has(i)) available.push(i);
  if (!available.length) { await endGame(null); return; }

  const n = available[Math.floor(Math.random() * available.length)];
  drawn.push(n);

  await db.ref(`activeGame/drawnNumbers/${n}`).set({
    number   : n,
    letter   : letter(n),
    drawnAt  : admin.database.ServerValue.TIMESTAMP,
    sequence : drawn.length,
  });
  log(`Drew: ${letter(n)}${n}  (${drawn.length}/75)`);
}

// ── START DRAW LOOP ───────────────────────────────────────────────
function startDrawLoop() {
  if (drawTimer) clearInterval(drawTimer);
  log(`Draw loop started — interval ${CONFIG.drawIntervalMs}ms`);
  drawTimer = setInterval(async () => {
    if (!gameRunning) { clearInterval(drawTimer); return; }
    // Check game not already ended in DB
    const endedSnap = await db.ref("activeGame/ended").once("value");
    if (endedSnap.val() === true) { gameRunning = false; clearInterval(drawTimer); return; }
    await drawNumber();
  }, CONFIG.drawIntervalMs);
}

// ── WINNER VERIFICATION ──────────────────────────────────────────
// The backend verifies each claimed win against the drawn numbers.
// Invalid claims are rejected; valid ones are confirmed.
function verifyWin(claimEntry, drawnSet) {
  const { cardFull, patternIndices } = claimEntry;
  if (!cardFull || !patternIndices) return false;
  // Free cell (index 12) always counts
  return patternIndices.every(idx => {
    if (idx === 12) return true;
    const val = parseInt(cardFull[idx]);
    return drawnSet.has(val);
  });
}

// ── HANDLE WINNER CLAIMS ─────────────────────────────────────────
async function handleWinnerClaims() {
  const winnersSnap = await db.ref("activeGame/winners").once("value");
  if (!winnersSnap.exists()) { await endGame(null); return; }

  const drawnSet = new Set(drawn);
  const allClaims = Object.entries(winnersSnap.val());
  
  // Verify each claim
  const valid = allClaims.filter(([, v]) => verifyWin(v, drawnSet));
  
  if (valid.length === 0) {
    log("All claims failed verification — continuing game");
    // Remove invalid claims and continue
    await db.ref("activeGame/winners").remove();
    gameRunning = true;
    startDrawLoop();
    return;
  }

  log(`${valid.length} valid winner(s): ${valid.map(([,v]) => v.name + " card#" + v.cardNum).join(", ")}`);

  // Fetch prize pool
  const takenSnap    = await db.ref("lobby/takenCards").once("value");
  const stakeSnap    = await db.ref("activeGame/stake").once("value");
  const takenCount   = takenSnap.exists() ? Object.keys(takenSnap.val()).length : 0;
  const stakeVal     = parseInt(stakeSnap.val() || "10");
  const totalPrize   = Math.floor(takenCount * stakeVal * 0.8);
  const splitPrize   = Math.floor(totalPrize / valid.length);

  // Write verified winners with prize info
  const verifiedMap = {};
  valid.forEach(([key, claim]) => {
    verifiedMap[key] = {
      ...claim,
      verified    : true,
      totalPrize,
      splitPrize,
      totalWinners: valid.length,
    };
  });

  await db.ref("activeGame/verifiedWinners").set(verifiedMap);
  log(`Prize: ${totalPrize} ETB total / ${splitPrize} ETB each`);

  await endGame(verifiedMap);
}

// ── END GAME ─────────────────────────────────────────────────────
async function endGame(verifiedWinners) {
  gameRunning = false;
  if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
  if (winCollectTimer) { clearTimeout(winCollectTimer); winCollectTimer = null; }

  await db.ref("activeGame").update({
    ended      : true,
    endedAt    : admin.database.ServerValue.TIMESTAMP,
    totalDrawn : drawn.length,
  });

  log("Game ended —", verifiedWinners ? Object.keys(verifiedWinners).length + " winner(s)" : "no winners");

  // Keep runner alive to watch for next game
  watchForNextGame();
}

// ── WATCH FOR NEXT GAME ──────────────────────────────────────────
function watchForNextGame() {
  log("Watching for next game...");
  db.ref("activeGame/started").on("value", async snap => {
    if (snap.val() === true && !gameRunning) {
      const endedSnap = await db.ref("activeGame/ended").once("value");
      if (endedSnap.val() === true) return; // stale game
      log("New game detected — starting draw loop");
      drawn = [];
      gameRunning = true;
      db.ref("activeGame/started").off(); // unsubscribe; re-subscribe after each game end
      startDrawLoop();
    }
  });

  // Watch for winner claims to verify
  db.ref("activeGame/winners").on("child_added", async () => {
    if (!gameRunning) return;
    // Collect window: wait for simultaneous claims
    if (winCollectTimer) clearTimeout(winCollectTimer);
    winCollectTimer = setTimeout(async () => {
      gameRunning = false;
      if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
      log(`Winner claim(s) received — verifying after ${CONFIG.winCollectMs}ms window`);
      await handleWinnerClaims();
    }, CONFIG.winCollectMs);
  });
}

// ── MAIN ─────────────────────────────────────────────────────────
async function main() {
  log("YDM Bingo Backend Runner starting...");

  await registerRunner();

  // Check if a game is already in progress
  const [startedSnap, endedSnap, drawnSnap] = await Promise.all([
    db.ref("activeGame/started").once("value"),
    db.ref("activeGame/ended").once("value"),
    db.ref("activeGame/drawnNumbers").once("value"),
  ]);

  if (startedSnap.val() === true && endedSnap.val() !== true) {
    // Resume in-progress game
    if (drawnSnap.exists()) {
      drawnSnap.forEach(c => { if (c.val()?.number) drawn.push(c.val().number); });
      drawn.sort((a,b) => a - b);
    }
    log(`Resuming game — ${drawn.length} numbers already drawn`);
    gameRunning = true;
    startDrawLoop();

    // Also set up winner watch for the resumed game
    db.ref("activeGame/winners").on("child_added", async () => {
      if (!gameRunning) return;
      if (winCollectTimer) clearTimeout(winCollectTimer);
      winCollectTimer = setTimeout(async () => {
        gameRunning = false;
        if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
        await handleWinnerClaims();
      }, CONFIG.winCollectMs);
    });
  } else {
    watchForNextGame();
  }

  // Graceful shutdown
  process.on("SIGTERM", async () => { log("SIGTERM — shutting down"); await db.ref("activeGame/runner").remove(); process.exit(0); });
  process.on("SIGINT",  async () => { log("SIGINT — shutting down");  await db.ref("activeGame/runner").remove(); process.exit(0); });
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });