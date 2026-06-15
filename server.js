const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const csv = require('csvtojson');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ── External Endpoints ────────────────────────────────────────────────────────
const SENTINEL_URL = "https://script.google.com/macros/s/AKfycby_FXyDMq0K0dW2kpRuaW0NdSTEy-9X8JrHIttJdjpadXs0cKV9Lr9Hg2EKY9pJhGdU/exec";
const VOTING_BRIDGE_URL = "https://script.google.com/macros/s/AKfycbwqSMQT__Dr_XBQ_MKGejF9uGEydol66clmztRRGojgfoqnYQ7iyGQ7RsWQoF2iILv9cA/exec";
const VOTING_CSV_URL = "https://docs.google.com/spreadsheets/d/1K1AFepyqCMKYSeoaQ40wn18_uRF4vLfA0ckPMZxcisg/gviz/tq?tqx=out:csv&sheet=Voting_Matches";

// ── Cloudflare Config ─────────────────────────────────────────────────────────
const CF_CONFIG = {
  accId: process.env.CLOUDFLARE_ACCOUNT_ID,
  token: process.env.CLOUDFLARE_API_TOKEN,
  uid: process.env.CLOUDFLARE_VIDEO_ID
};

// ── Central Game State ────────────────────────────────────────────────────────
let gameState = {
  refereeId: null,
  allViewers: [],
  availableCards: [],
  team1Picks: [],
  team2Picks: [],
  team1Player: null,
  team2Player: null,
  currentTurn: "team1",
  gameStarted: false,
  matchLocked: false,
  youtubeLink: "https://www.youtube.com",
  arenaBanner: "",
  qrCodes: ["", "", "", "", "", ""],
  team1Formation: "4-4-2",
  team2Formation: "4-4-2",
  team1Tactics: {},
  team2Tactics: {},
  
  // ── VOTING ENGINE DATA ──
  votingMatches: [] // Merged Type A (Live) + Type B (Spreadsheet CSV) [cite: 3]
};

//  ════════════════════════════════════════════════════════════════════════════
//  VOTING ENGINE HELPERS
//  ════════════════════════════════════════════════════════════════════════════

// Fetch manual Type B matches from your public CSV link [cite: 4]
async function fetchTypeBMatches() {
  try {
    const res = await axios.get(VOTING_CSV_URL, { timeout: 8000 }); [cite: 5]
    const rows = await csv().fromString(res.data); [cite: 6]
    return rows.map(row => ({
      matchId: String(row["Match_ID"] || row["matchId"] || ""),
      name: String(row["Match_Name"] || row["name"] || "Unnamed Match"),
      matchType: "B",
      status: String(row["Status"] || row["status"] || "CLOSED").toUpperCase(),
      coach1: String(row["Coach_1"] || row["coach1"] || ""),
      coach2: String(row["Coach_2"] || row["coach2"] || ""),
      team1Players: String(row["Team_1_Players"] || row["team1Players"] || ""),
      team2Players: String(row["Team_2_Players"] || row["team2Players"] || ""),
      t1Tactics: null,
      t2Tactics: null
    })); [cite: 6]
  } catch (err) {
    console.error("[Voting] CSV fetch error:", err.message); [cite: 7]
    return [];
  }
}

// Fetch saved Type A live matches from the Google deployment [cite: 8]
async function fetchTypeAMatches() {
  try {
    const res = await axios.get(`${VOTING_BRIDGE_URL}?action=getLiveMatches`, { maxRedirects: 5, timeout: 8000 }); [cite: 9]
    const raw = res.data; [cite: 10]
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.matches) ? raw.matches : []; [cite: 10]
    return list.map(m => ({ ...m, matchType: "A" })); [cite: 11]
  } catch (err) {
    console.error("[Voting] Bridge live matches fetch error:", err.message); [cite: 11]
    return [];
  }
}

// Merge collections together, giving precedence to live data if IDs match [cite: 12, 13]
async function fetchVotingMatches() {
  const [typeB, typeA] = await Promise.all([fetchTypeBMatches(), fetchTypeAMatches()]); [cite: 13]
  const merged = [...typeB]; [cite: 14]
  for (const am of typeA) {
    const idx = merged.findIndex(m => String(m.matchId) === String(am.matchId)); [cite: 14]
    if (idx !== -1) merged[idx] = am; [cite: 15]
    else merged.push(am); [cite: 15]
  }
  return merged; [cite: 15]
}

async function refreshVotingMatches() {
  try {
    gameState.votingMatches = await fetchVotingMatches(); [cite: 17]
    io.emit('gameStateUpdate', gameState); [cite: 17]
    console.log(`[Voting] Refreshed – ${gameState.votingMatches.length} matches total`); [cite: 17]
  } catch (err) {
    console.error("[Voting] refreshVotingMatches failed:", err.message); [cite: 18]
  }
}

// Automatically poll changes in background every 60 seconds [cite: 18]
setInterval(refreshVotingMatches, 60000); [cite: 18]

// ── Cloudflare Handshake ──────────────────────────────────────────────────────
async function getSecureStream() {
  if (!CF_CONFIG.token || !CF_CONFIG.accId || !CF_CONFIG.uid) return null; [cite: 19]
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_CONFIG.accId}/stream/${CF_CONFIG.uid}/token`; [cite: 20]
    const res = await axios.post(url, {}, { headers: { 'Authorization': `Bearer ${CF_CONFIG.token}`, 'Content-Type': 'application/json' } }); [cite: 20]
    if (res.data?.result?.token) { [cite: 21]
      return `https://customer-v7ps8f9e01.cloudflarestream.com/${res.data.result.token}/iframe`; [cite: 21]
    }
    return null;
  } catch (err) {
    console.error("[CF] Handshake failed:", err.message); [cite: 21]
    return null;
  }
}

//  ════════════════════════════════════════════════════════════════════════════
//  SOCKET CONNECTIONS
//  ════════════════════════════════════════════════════════════════════════════
io.on('connection', async (socket) => {
  if (gameState.votingMatches.length === 0) { [cite: 22]
    await refreshVotingMatches(); [cite: 22]
  }
  socket.emit('gameStateUpdate', gameState); [cite: 22]

  // --- CORE DRAFT MECHANICS HANDLERS (UNTOUCHED) --- [cite: 22]
  socket.on('claimReferee', (token) => {
    if (token === "eric_ref_2024") {
      gameState.refereeId = socket.id;
      io.emit('gameStateUpdate', gameState);
      socket.emit('refConfirm', true);
    }
  });

  socket.on('joinWaitingRoom', async (data) => {
    const name = data.name?.trim();
    const txId = data.ticketCode?.trim();
    if (!txId || !name) return; [cite: 22, 98]
    const alreadyActive = gameState.allViewers.find(v => v.txId === txId && v.id !== socket.id); [cite: 23]
    if (alreadyActive) return socket.emit('error', 'Iyi code iri gukoreshwa n\'undi muntu.'); [cite: 24]
    try {
      const verificationUrl = `${SENTINEL_URL}?code=${txId}&name=${encodeURIComponent(name)}`; [cite: 24]
      const response = await axios.get(verificationUrl, { maxRedirects: 5 }); [cite: 25]
      if (response.data && response.data.valid) { [cite: 25]
        const amount = Number(response.data.amount) || 0; [cite: 25]
        let secureLink = (amount >= 2000) ? await getSecureStream() : null; [cite: 26]
        let userIdx = gameState.allViewers.findIndex(v => v.txId === txId); [cite: 26]
        if (userIdx !== -1) { [cite: 26]
          gameState.allViewers[userIdx].id = socket.id; [cite: 27]
          gameState.allViewers[userIdx].secureLink = secureLink; [cite: 27]
          gameState.allViewers[userIdx].isPremium = (amount >= 2000); [cite: 27]
          if (gameState.team1Player?.txId === txId) gameState.team1Player.id = socket.id; [cite: 28]
          if (gameState.team2Player?.txId === txId) gameState.team2Player.id = socket.id; [cite: 28]
        } else {
          gameState.allViewers.push({ id: socket.id, name, role: 'spectator', txId, isPremium: (amount >= 2000), secureLink }); [cite: 29]
        }
        io.emit('gameStateUpdate', gameState); [cite: 29]
      } else {
        socket.emit('error', 'Iyi code ntizwi cyangwa ntiyishyuwe.'); [cite: 30]
      }
    } catch {
      socket.emit('error', 'Sentinel Error'); [cite: 30]
    }
  });

  socket.on('refUpdateBanner', (url) => { if (socket.id === gameState.refereeId) { gameState.arenaBanner = url; io.emit('gameStateUpdate', gameState); } });
  socket.on('refAssignRole', (data) => {
    if (socket.id !== gameState.refereeId) return; [cite: 32]
    const user = gameState.allViewers.find(v => v.id === data.userId); [cite: 32]
    if (user) {
      user.role = data.role; [cite: 32]
      if (data.role === 'team1') gameState.team1Player = { id: user.id, name: user.name, txId: user.txId }; [cite: 32]
      if (data.role === 'team2') gameState.team2Player = { id: user.id, name: user.name, txId: user.txId }; [cite: 32]
      io.emit('gameStateUpdate', gameState); [cite: 32]
    }
  });

  socket.on('refStartDraft', async () => {
    if (socket.id !== gameState.refereeId) return; [cite: 33]
    try {
      const response = await axios.get(process.env.SHEET_URL); [cite: 33]
      gameState.availableCards = (await csv().fromString(response.data)).slice(0, 100); [cite: 33]
      gameState.gameStarted = true; gameState.matchLocked = false; [cite: 33]
      gameState.team1Picks = []; gameState.team2Picks = []; [cite: 33]
      gameState.team1Tactics = {}; gameState.team2Tactics = {}; [cite: 33]
      gameState.currentTurn = "team1"; [cite: 33]
      io.emit('gameStateUpdate', gameState); io.emit('gameSyncPhase', 'DRAFT'); [cite: 33]
    } catch { console.log("[Draft] Start error"); }
  });

  socket.on('refReset', () => {
    if (socket.id !== gameState.refereeId) return; [cite: 34]
    gameState.gameStarted = false; gameState.matchLocked = false; [cite: 34]
    gameState.team1Picks = []; gameState.team2Picks = []; [cite: 34]
    gameState.team1Tactics = {}; gameState.team2Tactics = {}; [cite: 34]
    gameState.team1Player = null; gameState.team2Player = null; [cite: 34]
    gameState.allViewers.forEach(v => (v.role = 'spectator')); [cite: 34]
    io.emit('gameStateUpdate', gameState); io.emit('gameSyncPhase', 'LOBBY'); [cite: 34]
  });

  socket.on('refClearArena', () => {
    if (socket.id !== gameState.refereeId) return; [cite: 35]
    gameState.allViewers = []; gameState.gameStarted = false; [cite: 35]
    gameState.qrCodes = ["", "", "", "", "", ""]; gameState.youtubeLink = "https://www.youtube.com"; gameState.arenaBanner = ""; [cite: 35]
    io.emit('clearArenaForce'); io.emit('gameStateUpdate', gameState); [cite: 35]
  });

  socket.on('refUpdateYoutube', (link) => { if (socket.id === gameState.refereeId) { gameState.youtubeLink = link; io.emit('gameStateUpdate', gameState); } });
  socket.on('refUpdateQRs', (qrs) => { if (socket.id === gameState.refereeId) { gameState.qrCodes = qrs; io.emit('gameStateUpdate', gameState); } });
  socket.on('refLockMatch', () => { if (socket.id === gameState.refereeId) { gameState.matchLocked = true; io.emit('gameStateUpdate', gameState); } });
  
  socket.on('playerPickCard', (cardId) => {
    const user = gameState.allViewers.find(v => v.id === socket.id); [cite: 39]
    if (!user || user.role !== gameState.currentTurn) return; [cite: 39]
    const card = gameState.availableCards.find(c => c.id === cardId); [cite: 39]
    if (card) {
      const myTeam = user.role === 'team1' ? gameState.team1Picks : gameState.team2Picks; [cite: 39]
      if (myTeam.length >= 11) return; [cite: 39]
      myTeam.push(card); [cite: 39]
      gameState.availableCards = gameState.availableCards.filter(c => c.id !== cardId); [cite: 39]
      const otherTeam = user.role === 'team1' ? 'team2' : 'team1'; [cite: 39]
      const otherPicks = user.role === 'team1' ? gameState.team2Picks : gameState.team1Picks; [cite: 39]
      if (gameState.team1Picks.length >= 11 && gameState.team2Picks.length >= 11) { [cite: 39]
        gameState.currentTurn = "FINISHED"; [cite: 39]
      } else {
        gameState.currentTurn = (otherPicks.length < 11) ? otherTeam : user.role; [cite: 39]
      }
      io.emit('gameStateUpdate', gameState); [cite: 39]
    }
  });

  socket.on('playerSetPosition', (data) => {
    if (gameState.matchLocked) return; [cite: 40]
    const user = gameState.allViewers.find(v => v.id === socket.id); [cite: 40]
    if (!user || !user.role.startsWith('team')) return; [cite: 40]
    const tactics = gameState[`${user.role}Tactics`]; [cite: 40]
    const picks = gameState[`${user.role}Picks`]; [cite: 40]
    const card = picks.find(p => p.id === data.cardId); [cite: 40]
    if (card) {
      Object.keys(tactics).forEach(k => { if (tactics[k].id === data.cardId) delete tactics[k]; }); [cite: 40]
      tactics[data.slotIndex] = card; [cite: 40]
      io.emit('gameStateUpdate', gameState); [cite: 40]
    }
  });

  socket.on('playerSetFormation', (formation) => {
    if (gameState.matchLocked) return; [cite: 41]
    const user = gameState.allViewers.find(v => v.id === socket.id); [cite: 41]
    if (!user || !user.role.startsWith('team')) return; [cite: 41]
    gameState[`${user.role}Formation`] = formation; [cite: 41]
    gameState[`${user.role}Tactics`] = {}; [cite: 41]
    io.emit('gameStateUpdate', gameState); [cite: 41]
  });

  // --- NEW: VOTING ENGINE SOCKET LISTENERS --- [cite: 42]
  
  // Referee saves the active canvas team to sheet [cite: 42]
  socket.on('refSaveLiveSession', async () => {
    if (socket.id !== gameState.refereeId) return; [cite: 44]
    if (!gameState.matchLocked) { [cite: 44]
      return socket.emit('refSaveLiveSession_ack', { success: false, error: 'Match must be locked before saving.' }); [cite: 44]
    }
    const coach1 = gameState.team1Player?.name || "Coach 1"; [cite: 44]
    const coach2 = gameState.team2Player?.name || "Coach 2"; [cite: 44]
    const matchId = Date.now(); [cite: 44]
    
    const payload = {
      action: "saveLiveMatch",
      matchId,
      name: `Live Session – ${coach1} vs ${coach2}`,
      coach1,
      coach2,
      t1Tactics: JSON.stringify(gameState.team1Tactics),
      t2Tactics: JSON.stringify(gameState.team2Tactics)
    }; [cite: 44]

    try {
      await axios.post(VOTING_BRIDGE_URL, payload, { headers: { 'Content-Type': 'application/json' }, maxRedirects: 5, timeout: 10000 }); [cite: 44]
      await refreshVotingMatches(); [cite: 44, 45]
      socket.emit('refSaveLiveSession_ack', { success: true, matchId }); [cite: 45]
    } catch (err) {
      console.error("[Voting] saveLiveMatch error:", err.message); [cite: 46]
      socket.emit('refSaveLiveSession_ack', { success: false, error: err.message }); [cite: 46]
    }
  });

  // Referee changes a game state between OPEN and CLOSED [cite: 47]
  socket.on('refToggleVotingStatus', async ({ matchId, matchType, newStatus }) => {
    if (socket.id !== gameState.refereeId) return; [cite: 50]
    
    // Optimistic local update so users feel no delay [cite: 50]
    const idx = gameState.votingMatches.findIndex(m => String(m.matchId) === String(matchId)); [cite: 50]
    if (idx !== -1) {
      gameState.votingMatches[idx].status = newStatus; [cite: 50]
      io.emit('gameStateUpdate', gameState); [cite: 50]
    }

    try {
      await axios.post(VOTING_BRIDGE_URL, { action: "toggleVotingStatus", matchId, matchType, newStatus }, { headers: { 'Content-Type': 'application/json' }, maxRedirects: 5, timeout: 10000 }); [cite: 50]
    } catch (err) {
      console.error("[Voting] toggleVotingStatus sync error:", err.message); [cite: 50]
    }
  });

  // Referee-Exclusive: Pull raw calculations 
  socket.on('refGetBallots', async ({ matchId }) => {
    if (socket.id !== gameState.refereeId) return; [cite: 54]
    try {
      const res = await axios.get(`${VOTING_BRIDGE_URL}?action=getBallots&matchId=${encodeURIComponent(matchId)}`, { maxRedirects: 5, timeout: 12000 }); [cite: 54]
      const ballots = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.ballots) ? res.data.ballots : []; [cite: 54]
      socket.emit('refBallotData', { matchId, ballots }); [cite: 54]
    } catch (err) {
      console.error("[Voting] getBallots error:", err.message); [cite: 54]
      socket.emit('refBallotData', { matchId, ballots: [], error: err.message }); [cite: 54]
    }
  });

  socket.on('refRefreshVotingMatches', async () => {
    if (socket.id !== gameState.refereeId) return; [cite: 57]
    await refreshVotingMatches(); [cite: 57]
  });

  // Fans post their ballots blindly [cite: 58]
  socket.on('fanSubmitBallot', async ({ txId, matchId, coachVote, scores }) => {
    const viewer = gameState.allViewers.find(v => v.id === socket.id && v.txId === txId); [cite: 63]
    if (!viewer) return socket.emit('ballotResult', { error: 'NOT_VERIFIED' }); [cite: 63]

    const match = gameState.votingMatches.find(m => String(m.matchId) === String(matchId)); [cite: 63]
    if (!match || match.status !== "OPEN") return socket.emit('ballotResult', { error: 'MATCH_CLOSED' }); [cite: 63]

    try {
      const res = await axios.post(VOTING_BRIDGE_URL, { action: "submitBallot", txId, matchId, coachVote, scores }, { headers: { 'Content-Type': 'application/json' }, maxRedirects: 5, timeout: 12000 }); [cite: 63, 64]
      const data = res.data; [cite: 64]
      const alreadyVoted = data === "ALREADY_VOTED" || data?.error === "ALREADY_VOTED" || data?.result === "ALREADY_VOTED"; [cite: 64]
      
      if (alreadyVoted) {
        return socket.emit('ballotResult', { error: 'ALREADY_VOTED' }); [cite: 65]
      }
      socket.emit('ballotResult', { success: true }); [cite: 65]
    } catch (err) {
      console.error("[Voting] submitBallot network error:", err.message); [cite: 66]
      socket.emit('ballotResult', { error: 'SERVER_ERROR' }); [cite: 66]
    }
  });
});

app.get('/health', (_req, res) => res.status(200).send('Arena Engine is Awake')); [cite: 67]

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Arena Backend Masterpiece Online — port ${PORT}`); [cite: 69]
  refreshVotingMatches(); [cite: 69]
});
