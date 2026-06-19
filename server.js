const express = require('express');
const http = require('http');
const cors = require('cors');
const axios = require('axios');
const csv = require('csvtojson');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── External Endpoints ─────────────────────────────────────────────────────────
const SENTINEL_URL = "https://script.google.com/macros/s/AKfycby_FXyDMq0K0dW2kpRuaW0NdSTEy-9X8JrHIttJdjpadXs0cKV9Lr9Hg2EKY9pJhGdU/exec";
const VOTING_BRIDGE_URL = "https://script.google.com/macros/s/AKfycbwqSMQT__Dr_XBQ_MKGejF9uGEydol66clmztRRGojgfoqnYQ7iyGQ7RsWQoF2iILv9cA/exec";
// Multi-tab Type B: base spreadsheet ID — tabs will be indexed dynamically
const VOTING_SHEET_BASE_URL = "https://docs.google.com/spreadsheets/d/1K1AFepyqCMKYSeoaQ40wn18_uRF4vLfA0ckPMZxcisg/gviz/tq?tqx=out:csv&sheet=";
const VOTING_CSV_URL = `${VOTING_SHEET_BASE_URL}Voting_Matches`;

// ── Cloudflare Config ──────────────────────────────────────────────────────────
const CF_CONFIG = {
  accId: process.env.CLOUDFLARE_ACCOUNT_ID,
  token: process.env.CLOUDFLARE_API_TOKEN,
  uid: process.env.CLOUDFLARE_VIDEO_ID
};

// ══════════════════════════════════════════════════════════════════════════════
// STATE ARCHITECTURE
// ══════════════════════════════════════════════════════════════════════════════

let draftState = {
  refereeId: null,
  allViewers: [],
  availableCards: [],
  team1Picks: [],
  team2Picks: [],
  team1Player: null,
  team2Player: null,
  currentTurn: 'team1',
  gameStarted: false,
  // matchLocked = tactics stage locked (legacy). matchReady = full lockout.
  matchLocked: false,
  matchReady: false,           // NEW: "Match Ready" final lockout
  youtubeLink: 'https://www.youtube.com',
  arenaBanner: '',
  qrCodes: ['', '', '', '', '', ''],
  team1Formation: '4-4-2',
  team2Formation: '4-4-2',
  team1Tactics: {},            // { [slotIndex]: cardObject }
  team2Tactics: {},
  roomPhase: 'LOBBY',          // 'LOBBY' | 'DRAFT' | 'VOTING'
  savedLiveSessions: [],       // accumulates across resets — never wiped on reset
  votingAllowed: false,        // master gate
  // Spec §6: targeted mode — null | 'A' | 'B' | 'BOTH'
  votingMode: null,
};

let votingState = {
  votingMatches: [],
  voteRegistry: {},            // { [matchId]: Set<txId> }
  ballots: {},                 // { [matchId]: [{ txId, coachVote, teamVote, scores, ... }] }
};

function buildGameState() {
  const safeRegistry = {};
  for (const [mid, set] of Object.entries(votingState.voteRegistry)) {
    safeRegistry[mid] = [...set];
  }
  // Compute live aggregate stats for Ref dashboard (Spec §5.3)
  const typeAStats = computeTypeAStats();
  const typeBStats = computeTypeBStats();
  return {
    ...draftState,
    votingMatches: votingState.votingMatches,
    voteRegistry: safeRegistry,
    typeAStats,
    typeBStats,
  };
}

function broadcastState() {
  io.emit('gameStateUpdate', buildGameState());
}

// ── Live Aggregate Stats ───────────────────────────────────────────────────────
function computeTypeAStats() {
  // Returns { [matchId]: { team1Votes: N, team2Votes: N } }
  const stats = {};
  const typeAMatches = votingState.votingMatches.filter(m => m.matchType === 'A');
  for (const m of typeAMatches) {
    const ballots = votingState.ballots[m.matchId] || [];
    stats[m.matchId] = {
      matchName: m.name,
      team1Votes: ballots.filter(b => b.teamVote === 'team1').length,
      team2Votes: ballots.filter(b => b.teamVote === 'team2').length,
    };
  }
  return stats;
}

function computeTypeBStats() {
  // Returns { [matchId]: { [participantName]: averageScore } }
  const stats = {};
  const typeBMatches = votingState.votingMatches.filter(m => m.matchType === 'B');
  for (const m of typeBMatches) {
    const ballots = votingState.ballots[m.matchId] || [];
    if (!ballots.length) { stats[m.matchId] = {}; continue; }
    const totals = {};
    const counts = {};
    for (const b of ballots) {
      if (!b.scores) continue;
      for (const [name, score] of Object.entries(b.scores)) {
        totals[name] = (totals[name] || 0) + Number(score);
        counts[name] = (counts[name] || 0) + 1;
      }
    }
    stats[m.matchId] = {};
    for (const name of Object.keys(totals)) {
      stats[m.matchId][name] = (totals[name] / counts[name]).toFixed(2);
    }
  }
  return stats;
}

// ══════════════════════════════════════════════════════════════════════════════
// VOTING ENGINE HELPERS
// ══════════════════════════════════════════════════════════════════════════════

// Type B: Spec §4 — fetch MULTIPLE tabs from the Google Sheet
// Tab names are stored in env var VOTING_SHEET_TABS as comma-separated list
// e.g. "Match_001,Match_002,Match_003"
// Falls back to single "Voting_Matches" tab if not set.
async function fetchTypeBMatches() {
  try {
    const tabsEnv = process.env.VOTING_SHEET_TABS || 'Voting_Matches';
    const tabs = tabsEnv.split(',').map(t => t.trim()).filter(Boolean);
    const results = await Promise.all(tabs.map(async (tab) => {
      try {
        const res = await axios.get(`${VOTING_SHEET_BASE_URL}${encodeURIComponent(tab)}`, { timeout: 8000 });
        const rows = await csv().fromString(res.data);
        return rows.map(row => ({
          matchId: String(row['Match_ID'] || row['matchId'] || `${tab}_${Math.random()}`),
          name: String(row['Match_Name'] || row['name'] || `Match (${tab})`),
          matchType: 'B',
          status: String(row['Status'] || row['status'] || 'CLOSED').toUpperCase(),
          coach1: String(row['Coach_1'] || row['coach1'] || ''),
          coach2: String(row['Coach_2'] || row['coach2'] || ''),
          referee1: String(row['Referee'] || row['referee'] || ''),
          commentator1: String(row['Commentator'] || row['commentator'] || ''),
          team1Players: String(row['Team_1_Players'] || row['team1Players'] || ''),
          team2Players: String(row['Team_2_Players'] || row['team2Players'] || ''),
          t1Tactics: null,
          t2Tactics: null,
        }));
      } catch {
        return [];
      }
    }));
    return results.flat();
  } catch (err) {
    console.error('[Voting] CSV fetch error:', err.message);
    return [];
  }
}

async function fetchTypeAMatches() {
  try {
    const res = await axios.get(`${VOTING_BRIDGE_URL}?action=getLiveMatches`, { maxRedirects: 5, timeout: 8000 });
    const raw = res.data;
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.matches) ? raw.matches : [];
    return list.map(m => ({ ...m, matchType: 'A' }));
  } catch (err) {
    console.error('[Voting] Bridge live matches fetch error:', err.message);
    return [];
  }
}

async function fetchVotingMatches() {
  const [typeB, typeA] = await Promise.all([fetchTypeBMatches(), fetchTypeAMatches()]);
  const merged = [...typeB];
  for (const am of typeA) {
    const idx = merged.findIndex(m => String(m.matchId) === String(am.matchId));
    if (idx !== -1) merged[idx] = am;
    else merged.push(am);
  }
  return merged;
}

async function refreshVotingMatches() {
  try {
    const fetched = await fetchVotingMatches();
    // Merge in savedLiveSessions as Type A
    const sessionMatches = draftState.savedLiveSessions.map(s => ({
      matchId: s.matchId,
      name: s.name,
      matchType: 'A',
      status: s.status || 'CLOSED',
      coach1: s.team1Player?.name || '',
      coach2: s.team2Player?.name || '',
      t1Tactics: s.team1Tactics || {},
      t2Tactics: s.team2Tactics || {},
      team1Players: '',
      team2Players: '',
    }));
    const merged = [...fetched];
    for (const sm of sessionMatches) {
      const idx = merged.findIndex(m => String(m.matchId) === String(sm.matchId));
      if (idx !== -1) merged[idx] = { ...merged[idx], ...sm };
      else merged.push(sm);
    }
    votingState.votingMatches = merged;
    broadcastState();
    console.log(`[Voting] Refreshed -- ${votingState.votingMatches.length} matches total`);
  } catch (err) {
    console.error('[Voting] refreshVotingMatches failed:', err.message);
  }
}

// ── Cloudflare Handshake ───────────────────────────────────────────────────────
async function getSecureStream() {
  if (!CF_CONFIG.token || !CF_CONFIG.accId || !CF_CONFIG.uid) return null;
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_CONFIG.accId}/stream/${CF_CONFIG.uid}/token`;
    const res = await axios.post(url, {}, {
      headers: { Authorization: `Bearer ${CF_CONFIG.token}`, 'Content-Type': 'application/json' }
    });
    if (res.data?.result?.token) {
      return `https://customer-v7ps8f9e01.cloudflarestream.com/${res.data.result.token}/iframe`;
    }
    return null;
  } catch (err) {
    console.error('[CF] Handshake failed:', err.message);
    return null;
  }
}

// ── REST: State polling endpoint ───────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  res.json(buildGameState());
});

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);
  socket.emit('gameStateUpdate', buildGameState());

  // ── Claim Referee ──────────────────────────────────────────────────────────
  socket.on('claimReferee', (token) => {
    if (token === 'eric_ref_2024') {
      draftState.refereeId = socket.id;
      socket.emit('refConfirm', true);
      broadcastState();
    }
  });

  // ── Join Waiting Room — Smart reconnect (Spec §7) ──────────────────────────
  socket.on('joinWaitingRoom', async ({ name, ticketCode } = {}) => {
    if (!ticketCode || !name) return;
    const existingUser = draftState.allViewers.find(v => v.txId === ticketCode);
    if (existingUser) {
      // Silent re-bind — page refresh, not a new device
      existingUser.id = socket.id;
      if (draftState.team1Player?.txId === ticketCode) draftState.team1Player.id = socket.id;
      if (draftState.team2Player?.txId === ticketCode) draftState.team2Player.id = socket.id;
      socket.emit('gameStateUpdate', buildGameState());
      broadcastState();
      return;
    }
    try {
      const verificationUrl = `${SENTINEL_URL}?code=${ticketCode}&name=${encodeURIComponent(name)}`;
      const response = await axios.get(verificationUrl, { maxRedirects: 5 });
      if (response.data && response.data.valid) {
        const amount = Number(response.data.amount) || 0;
        const secureLink = amount >= 2000 ? await getSecureStream() : null;
        draftState.allViewers.push({
          id: socket.id,
          name: name.trim(),
          role: 'spectator',
          txId: ticketCode,
          isPremium: amount >= 2000,
          secureLink
        });
        broadcastState();
      } else {
        socket.emit('error', 'Iyi code ntizwi cyangwa ntiyishyuwe.');
      }
    } catch {
      socket.emit('error', 'Sentinel Error');
    }
  });

  // ── Referee: Media controls ────────────────────────────────────────────────
  socket.on('refUpdateYoutube', (link) => {
    if (socket.id !== draftState.refereeId) return;
    draftState.youtubeLink = link;
    broadcastState();
  });

  socket.on('refUpdateBanner', (url) => {
    if (socket.id !== draftState.refereeId) return;
    draftState.arenaBanner = url;
    broadcastState();
  });

  socket.on('refUpdateQRs', (qrs) => {
    if (socket.id !== draftState.refereeId) return;
    if (Array.isArray(qrs)) draftState.qrCodes = qrs;
    broadcastState();
  });

  // ── Referee: Assign role ───────────────────────────────────────────────────
  socket.on('refAssignRole', ({ userId, role } = {}) => {
    if (socket.id !== draftState.refereeId) return;
    const user = draftState.allViewers.find(v => v.id === userId);
    if (user) {
      user.role = role;
      if (role === 'team1') draftState.team1Player = { id: user.id, name: user.name, txId: user.txId };
      if (role === 'team2') draftState.team2Player = { id: user.id, name: user.name, txId: user.txId };
      broadcastState();
    }
  });

  // ── Referee: Start draft ───────────────────────────────────────────────────
  socket.on('refStartDraft', async () => {
    if (socket.id !== draftState.refereeId) return;
    try {
      const response = await axios.get(process.env.SHEET_URL, { timeout: 10000 });
      draftState.availableCards = (await csv().fromString(response.data)).slice(0, 100);
      draftState.gameStarted = true;
      draftState.matchLocked = false;
      draftState.matchReady = false;
      draftState.team1Picks = [];
      draftState.team2Picks = [];
      draftState.team1Tactics = {};
      draftState.team2Tactics = {};
      draftState.currentTurn = 'team1';
      draftState.team1Formation = '4-4-2';
      draftState.team2Formation = '4-4-2';
      draftState.roomPhase = 'DRAFT';
      broadcastState();
      io.emit('gameSyncPhase', 'DRAFT');
    } catch (err) {
      console.error('[Draft] Start error:', err.message);
      socket.emit('error', 'Failed to load draft cards.');
    }
  });

  // ── Referee: Lock match (tactics stage) ───────────────────────────────────
  socket.on('refLockMatch', () => {
    if (socket.id !== draftState.refereeId) return;
    draftState.matchLocked = true;
    broadcastState();
  });

  // ── NEW Spec §2: "Match Ready" — permanent full lockout ───────────────────
  socket.on('refMatchReady', () => {
    if (socket.id !== draftState.refereeId) return;
    draftState.matchReady = true;
    draftState.matchLocked = true;
    broadcastState();
    socket.emit('refMatchReady_ack', { success: true });
  });

  // ── NEW Spec §3: Save Session for Voting (name = "Coach1 vs Coach2") ───────
  socket.on('refSaveLiveSession', () => {
    if (socket.id !== draftState.refereeId) return;
    if (!draftState.matchReady) {
      socket.emit('refSaveLiveSession_ack', { success: false, error: 'Click "Match Ready" first.' });
      return;
    }
    const sessionId = `live_${Date.now()}`;
    // Name: "Kaka vs Jay" as per spec
    const sessionName = `${draftState.team1Player?.name || 'Team 1'} vs ${draftState.team2Player?.name || 'Team 2'}`;
    const session = {
      matchId: sessionId,
      name: sessionName,
      team1Player: { ...draftState.team1Player },
      team2Player: { ...draftState.team2Player },
      team1Picks: [...draftState.team1Picks],
      team2Picks: [...draftState.team2Picks],
      team1Formation: draftState.team1Formation,
      team2Formation: draftState.team2Formation,
      team1Tactics: { ...draftState.team1Tactics },
      team2Tactics: { ...draftState.team2Tactics },
      status: 'CLOSED',
      savedAt: Date.now(),
    };
    draftState.savedLiveSessions.push(session);
    votingState.votingMatches.push({
      matchId: sessionId,
      name: sessionName,
      matchType: 'A',
      status: 'CLOSED',
      coach1: session.team1Player?.name || '',
      coach2: session.team2Player?.name || '',
      t1Tactics: session.team1Tactics,
      t2Tactics: session.team2Tactics,
      team1Players: '',
      team2Players: '',
    });
    socket.emit('refSaveLiveSession_ack', { success: true, matchId: sessionId });
    broadcastState();
    console.log(`[Session] Saved: ${sessionName} (${sessionId})`);
  });

  // ── Referee: Restart (same players, preserved sessions) ───────────────────
  socket.on('refRestart', () => {
    if (socket.id !== draftState.refereeId) return;
    const preserved = {
      refereeId: draftState.refereeId,
      allViewers: draftState.allViewers,
      team1Player: draftState.team1Player,
      team2Player: draftState.team2Player,
      savedLiveSessions: draftState.savedLiveSessions,
      youtubeLink: draftState.youtubeLink,
      arenaBanner: draftState.arenaBanner,
      qrCodes: draftState.qrCodes,
      votingAllowed: draftState.votingAllowed,
      votingMode: draftState.votingMode,
    };
    draftState = {
      ...preserved,
      availableCards: [],
      team1Picks: [],
      team2Picks: [],
      currentTurn: 'team1',
      gameStarted: false,
      matchLocked: false,
      matchReady: false,
      team1Formation: '4-4-2',
      team2Formation: '4-4-2',
      team1Tactics: {},
      team2Tactics: {},
      roomPhase: 'LOBBY',
    };
    // Keep viewer roles
    broadcastState();
    io.emit('gameSyncPhase', 'LOBBY');
  });

  // ── Referee: Reset (new players, preserve sessions) ───────────────────────
  socket.on('refReset', () => {
    if (socket.id !== draftState.refereeId) return;
    const preserved = {
      refereeId: draftState.refereeId,
      allViewers: draftState.allViewers,
      savedLiveSessions: draftState.savedLiveSessions,
      youtubeLink: draftState.youtubeLink,
      arenaBanner: draftState.arenaBanner,
      qrCodes: draftState.qrCodes,
      votingAllowed: draftState.votingAllowed,
      votingMode: draftState.votingMode,
    };
    draftState = {
      ...preserved,
      availableCards: [],
      team1Picks: [],
      team2Picks: [],
      team1Player: null,
      team2Player: null,
      currentTurn: 'team1',
      gameStarted: false,
      matchLocked: false,
      matchReady: false,
      team1Formation: '4-4-2',
      team2Formation: '4-4-2',
      team1Tactics: {},
      team2Tactics: {},
      roomPhase: 'LOBBY',
    };
    draftState.allViewers.forEach(v => { v.role = 'spectator'; });
    broadcastState();
    io.emit('gameSyncPhase', 'LOBBY');
  });

  // ── Referee: Non-destructive phase navigation (Spec §6) ───────────────────
  socket.on('refSetPhase', (phase) => {
    if (socket.id !== draftState.refereeId) return;
    if (!['LOBBY', 'DRAFT', 'VOTING'].includes(phase)) return;
    draftState.roomPhase = phase;
    if (phase !== 'VOTING') draftState.votingAllowed = false;
    broadcastState();
    io.emit('gameSyncPhase', phase);
  });

  // ── Referee: Master voting gate + targeted mode (Spec §6) ─────────────────
  // payload: { allowed: bool, mode: null | 'A' | 'B' | 'BOTH' }
  socket.on('refToggleVotingGate', ({ allowed, mode } = {}) => {
    if (socket.id !== draftState.refereeId) return;
    draftState.votingAllowed = !!allowed;
    draftState.votingMode = allowed ? (mode || 'BOTH') : null;
    if (draftState.votingAllowed) {
      draftState.roomPhase = 'VOTING';
      io.emit('gameSyncPhase', 'VOTING');
    }
    broadcastState();
  });

  // ── Referee: Toggle individual match status ────────────────────────────────
  socket.on('refToggleVotingStatus', ({ matchId, matchType, newStatus } = {}) => {
    if (socket.id !== draftState.refereeId) return;
    const match = votingState.votingMatches.find(m => String(m.matchId) === String(matchId));
    if (match) {
      match.status = newStatus;
      const session = draftState.savedLiveSessions.find(s => String(s.matchId) === String(matchId));
      if (session) session.status = newStatus;
    }
    broadcastState();
  });

  // ── Referee: Refresh voting matches ───────────────────────────────────────
  socket.on('refRefreshVotingMatches', async () => {
    if (socket.id !== draftState.refereeId) return;
    await refreshVotingMatches();
  });

  // ── Referee: Get ballots ───────────────────────────────────────────────────
  socket.on('refGetBallots', ({ matchId } = {}) => {
    if (socket.id !== draftState.refereeId) return;
    const ballots = votingState.ballots[matchId] || [];
    socket.emit('refBallotData', { matchId, ballots });
  });

  // ── Fan: Submit ballot — 4-gate anti-cheat (Spec §6) ──────────────────────
  // Type A: { txId, matchId, teamVote: 'team1'|'team2', matchType: 'A' }
  // Type B: { txId, matchId, scores: { [name]: 0-10 }, matchType: 'B' }
  socket.on('fanSubmitBallot', ({ txId, matchId, teamVote, coachVote, scores, matchType } = {}) => {
    if (!draftState.votingAllowed) {
      socket.emit('ballotResult', { success: false, error: 'VOTING_LOCKED' });
      return;
    }
    // Spec §6: fan must only see/access the mode opened by Ref
    const mode = draftState.votingMode;
    if (mode !== 'BOTH' && mode !== matchType) {
      socket.emit('ballotResult', { success: false, error: 'MODE_NOT_OPEN' });
      return;
    }
    const match = votingState.votingMatches.find(m => String(m.matchId) === String(matchId));
    if (!match || match.status !== 'OPEN') {
      socket.emit('ballotResult', { success: false, error: 'MATCH_CLOSED' });
      return;
    }
    const voter = draftState.allViewers.find(v => v.txId === txId);
    if (!voter) {
      socket.emit('ballotResult', { success: false, error: 'NOT_VERIFIED' });
      return;
    }
    if (!votingState.voteRegistry[matchId]) votingState.voteRegistry[matchId] = new Set();
    if (votingState.voteRegistry[matchId].has(txId)) {
      socket.emit('ballotResult', { success: false, error: 'ALREADY_VOTED' });
      return;
    }
    votingState.voteRegistry[matchId].add(txId);
    if (!votingState.ballots[matchId]) votingState.ballots[matchId] = [];
    votingState.ballots[matchId].push({
      txId,
      teamVote: teamVote || null,   // Type A
      coachVote: coachVote || null, // legacy
      scores: scores || {},         // Type B
      matchType,
      submittedAt: Date.now()
    });
    socket.emit('ballotResult', { success: true });
    broadcastState();
  });

  // ── Player: Pick card (Spec §1 — card immediately hidden from pool) ────────
  socket.on('playerPickCard', (cardId) => {
    const viewer = draftState.allViewers.find(v => v.id === socket.id);
    if (!viewer || !draftState.gameStarted || draftState.matchLocked) return;
    if (viewer.role !== draftState.currentTurn) return;
    const cardIdx = draftState.availableCards.findIndex(c => String(c.id || c.Id) === String(cardId));
    if (cardIdx === -1) return;
    const [card] = draftState.availableCards.splice(cardIdx, 1); // Removed from pool immediately
    if (draftState.currentTurn === 'team1') {
      draftState.team1Picks.push(card);
      draftState.currentTurn = 'team2';
    } else {
      draftState.team2Picks.push(card);
      draftState.currentTurn = 'team1';
    }
    broadcastState();
  });

  // ── Player: Set position (Spec §2 — single-slot enforcement) ──────────────
  socket.on('playerSetPosition', ({ cardId, slotIndex } = {}) => {
    const viewer = draftState.allViewers.find(v => v.id === socket.id);
    if (!viewer || draftState.matchReady) return;
    const isTeam1 = viewer.role === 'team1';
    const tactics = isTeam1 ? draftState.team1Tactics : draftState.team2Tactics;
    const picks = isTeam1 ? draftState.team1Picks : draftState.team2Picks;
    const card = picks.find(c => String(c.id || c.Id) === String(cardId));
    if (!card) return;
    // Remove card from any existing slot (single-slot enforcement)
    for (const key of Object.keys(tactics)) {
      if (tactics[key] && String(tactics[key].id || tactics[key].Id) === String(cardId)) {
        delete tactics[key];
      }
    }
    tactics[slotIndex] = card;
    broadcastState();
  });

  // ── Player: Set formation ──────────────────────────────────────────────────
  socket.on('playerSetFormation', ({ team, formation } = {}) => {
    const viewer = draftState.allViewers.find(v => v.id === socket.id);
    if (!viewer || draftState.matchReady) return;
    if (viewer.role === 'team1' && team === 'team1') draftState.team1Formation = formation;
    if (viewer.role === 'team2' && team === 'team2') draftState.team2Formation = formation;
    broadcastState();
  });

  // ── Clear Arena — ULTIMATE full wipe (Spec §0) ────────────────────────────
  socket.on('refClearArena', () => {
    if (socket.id !== draftState.refereeId) return;
    draftState = {
      refereeId: null,
      allViewers: [],
      availableCards: [],
      team1Picks: [],
      team2Picks: [],
      team1Player: null,
      team2Player: null,
      currentTurn: 'team1',
      gameStarted: false,
      matchLocked: false,
      matchReady: false,
      youtubeLink: 'https://www.youtube.com',
      arenaBanner: '',
      qrCodes: ['', '', '', '', '', ''],
      team1Formation: '4-4-2',
      team2Formation: '4-4-2',
      team1Tactics: {},
      team2Tactics: {},
      roomPhase: 'LOBBY',
      savedLiveSessions: [],
      votingAllowed: false,
      votingMode: null,
    };
    votingState = { votingMatches: [], voteRegistry: {}, ballots: {} };
    io.emit('clearArenaForce');
    broadcastState();
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    // Do NOT remove viewers — socket ID will be rebound on reconnect (Spec §7)
  });
});

// ── Boot ───────────────────────────────────────────────────────────────────────
(async () => {
  await refreshVotingMatches();
  setInterval(refreshVotingMatches, 5 * 60 * 1000);
})();

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
