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

// ── Socket.io (Render.com persistent Node.js server — NOT serverless) ─────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── External Endpoints ─────────────────────────────────────────────────────────
const SENTINEL_URL = "https://script.google.com/macros/s/AKfycby_FXyDMq0K0dW2kpRuaW0NdSTEy-9X8JrHIttJdjpadXs0cKV9Lr9Hg2EKY9pJhGdU/exec";
const VOTING_BRIDGE_URL = "https://script.google.com/macros/s/AKfycbwqSMQT__Dr_XBQ_MKGejF9uGEydol66clmztRRGojgfoqnYQ7iyGQ7RsWQoF2iILv9cA/exec";
const VOTING_CSV_URL = "https://docs.google.com/spreadsheets/d/1K1AFepyqCMKYSeoaQ40wn18_uRF4vLfA0ckPMZxcisg/gviz/tq?tqx=out:csv&sheet=Voting_Matches";

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
  refereeId: null,          // socket.id of the current referee
  allViewers: [],
  availableCards: [],
  team1Picks: [],
  team2Picks: [],
  team1Player: null,
  team2Player: null,
  currentTurn: 'team1',
  gameStarted: false,
  matchLocked: false,
  youtubeLink: 'https://www.youtube.com',
  arenaBanner: '',
  qrCodes: ['', '', '', '', '', ''],
  team1Formation: '4-4-2',
  team2Formation: '4-4-2',
  team1Tactics: {},
  team2Tactics: {},

  // ── NEW: Room phase state (non-destructive navigation) ─────────────────────
  // Phases: 'LOBBY' | 'DRAFT' | 'VOTING'
  roomPhase: 'LOBBY',

  // ── NEW: Persistent saved live sessions (accumulate across resets) ──────────
  savedLiveSessions: [],

  // ── NEW: Master voting gate (Ref must explicitly unlock) ───────────────────
  votingAllowed: false,
};

let votingState = {
  votingMatches: [],
  // ── NEW: Anti-double vote registry { [matchId]: Set<txId> } ────────────────
  voteRegistry: {},
  // Ballot storage: { [matchId]: [ { txId, coachVote, scores } ] }
  ballots: {},
};

function buildGameState() {
  // Serialize voteRegistry as plain object (Sets are not JSON-serializable)
  const safeRegistry = {};
  for (const [mid, set] of Object.entries(votingState.voteRegistry)) {
    safeRegistry[mid] = [...set];
  }
  return {
    ...draftState,
    votingMatches: votingState.votingMatches,
    voteRegistry: safeRegistry,
  };
}

function broadcastState() {
  io.emit('gameStateUpdate', buildGameState());
}

// ══════════════════════════════════════════════════════════════════════════════
// VOTING ENGINE HELPERS
// ══════════════════════════════════════════════════════════════════════════════

async function fetchTypeBMatches() {
  try {
    const res = await axios.get(VOTING_CSV_URL, { timeout: 8000 });
    const rows = await csv().fromString(res.data);
    return rows.map(row => ({
      matchId: String(row['Match_ID'] || row['matchId'] || ''),
      name: String(row['Match_Name'] || row['name'] || 'Unnamed Match'),
      matchType: 'B',
      status: String(row['Status'] || row['status'] || 'CLOSED').toUpperCase(),
      coach1: String(row['Coach_1'] || row['coach1'] || ''),
      coach2: String(row['Coach_2'] || row['coach2'] || ''),
      team1Players: String(row['Team_1_Players'] || row['team1Players'] || ''),
      team2Players: String(row['Team_2_Players'] || row['team2Players'] || ''),
      t1Tactics: null,
      t2Tactics: null,
    }));
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
    // ── NEW Feature 3: Merge savedLiveSessions into votingMatches as Type A ───
    const fetched = await fetchVotingMatches();
    const sessionMatches = draftState.savedLiveSessions.map(s => ({
      matchId: s.matchId,
      name: s.name || `Live Session ${s.matchId}`,
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
      if (idx !== -1) merged[idx] = sm;
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

// ── REST: State polling endpoint (for App.js 3s interval) ─────────────────────
app.get('/api/state', (req, res) => {
  res.json(buildGameState());
});

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO EVENT HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // ── Auto-rejoin on reconnect ───────────────────────────────────────────────
  socket.emit('gameStateUpdate', buildGameState());

  // ── Claim Referee ──────────────────────────────────────────────────────────
  socket.on('claimReferee', (token) => {
    if (token === 'eric_ref_2024') {
      draftState.refereeId = socket.id;
      socket.emit('refConfirm', true);
      broadcastState();
    }
  });

  // ── Join Waiting Room ──────────────────────────────────────────────────────
  // NEW Feature 6: Smart error suppression — distinguish refresh vs new unauthorized device
  socket.on('joinWaitingRoom', async ({ name, ticketCode } = {}) => {
    if (!ticketCode || !name) return;

    const existingUser = draftState.allViewers.find(v => v.txId === ticketCode);

    if (existingUser) {
      // User is already authenticated — this is a page refresh. Silently update socket ID.
      existingUser.id = socket.id;
      if (draftState.team1Player?.txId === ticketCode) draftState.team1Player.id = socket.id;
      if (draftState.team2Player?.txId === ticketCode) draftState.team2Player.id = socket.id;
      socket.emit('gameStateUpdate', buildGameState());
      broadcastState();
      return; // No error popup — silent re-auth
    }

    // Check for another ACTIVE socket using same ticketCode from a DIFFERENT machine
    // (existingUser would have been found above if it was a refresh)
    // At this point, no record exists → proceed with fresh verification
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

  // ── Referee Controls ───────────────────────────────────────────────────────
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

  socket.on('refStartDraft', async () => {
    if (socket.id !== draftState.refereeId) return;
    try {
      const response = await axios.get(process.env.SHEET_URL, { timeout: 10000 });
      draftState.availableCards = (await csv().fromString(response.data)).slice(0, 100);
      draftState.gameStarted = true;
      draftState.matchLocked = false;
      draftState.team1Picks = [];
      draftState.team2Picks = [];
      draftState.team1Tactics = {};
      draftState.team2Tactics = {};
      draftState.currentTurn = 'team1';
      draftState.team1Formation = '4-4-2';
      draftState.team2Formation = '4-4-2';
      // ── NEW Feature 5: Non-destructive phase navigation ────────────────────
      draftState.roomPhase = 'DRAFT';
      broadcastState();
      io.emit('gameSyncPhase', 'DRAFT');
    } catch (err) {
      console.error('[Draft] Start error:', err.message);
      socket.emit('error', 'Failed to load draft cards.');
    }
  });

  socket.on('refLockMatch', () => {
    if (socket.id !== draftState.refereeId) return;
    draftState.matchLocked = true;
    broadcastState();
  });

  // ── NEW Feature 3: Save Live Session (persistent, non-destructive) ─────────
  socket.on('refSaveLiveSession', () => {
    if (socket.id !== draftState.refereeId) return;
    if (!draftState.matchLocked) {
      socket.emit('refSaveLiveSession_ack', { success: false, error: 'Match must be locked before saving.' });
      return;
    }
    const sessionId = `live_${Date.now()}`;
    const session = {
      matchId: sessionId,
      name: `${draftState.team1Player?.name || 'Team 1'} vs ${draftState.team2Player?.name || 'Team 2'} (${new Date().toLocaleTimeString()})`,
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
    // Register into votingMatches immediately
    votingState.votingMatches.push({
      matchId: sessionId,
      name: session.name,
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
    console.log(`[Session] Saved live session: ${sessionId}`);
  });

  // ── NEW Feature 5: Non-destructive Reset (preserves savedLiveSessions) ─────
  socket.on('refReset', () => {
    if (socket.id !== draftState.refereeId) return;
    // Preserve: refereeId, allViewers, savedLiveSessions, youtubeLink, arenaBanner, qrCodes, votingAllowed
    const preserved = {
      refereeId: draftState.refereeId,
      allViewers: draftState.allViewers,
      savedLiveSessions: draftState.savedLiveSessions,
      youtubeLink: draftState.youtubeLink,
      arenaBanner: draftState.arenaBanner,
      qrCodes: draftState.qrCodes,
      votingAllowed: draftState.votingAllowed,
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
      team1Formation: '4-4-2',
      team2Formation: '4-4-2',
      team1Tactics: {},
      team2Tactics: {},
      roomPhase: 'LOBBY',
    };
    // Reset viewer roles to spectator
    draftState.allViewers.forEach(v => { v.role = 'spectator'; });
    broadcastState();
    io.emit('gameSyncPhase', 'LOBBY');
  });

  // ── NEW Feature 5: Room Phase Navigation (Ref-controlled) ─────────────────
  socket.on('refSetPhase', (phase) => {
    if (socket.id !== draftState.refereeId) return;
    if (!['LOBBY', 'DRAFT', 'VOTING'].includes(phase)) return;
    draftState.roomPhase = phase;
    // Lock voting if going back from VOTING
    if (phase !== 'VOTING') {
      draftState.votingAllowed = false;
    }
    broadcastState();
    io.emit('gameSyncPhase', phase);
  });

  // ── NEW Feature 2: Master Voting Toggle ────────────────────────────────────
  socket.on('refToggleVotingGate', (allowed) => {
    if (socket.id !== draftState.refereeId) return;
    draftState.votingAllowed = !!allowed;
    if (draftState.votingAllowed) {
      draftState.roomPhase = 'VOTING';
      io.emit('gameSyncPhase', 'VOTING');
    }
    broadcastState();
  });

  // ── Voting: Toggle individual match status (Ref only) ─────────────────────
  socket.on('refToggleVotingStatus', ({ matchId, matchType, newStatus } = {}) => {
    if (socket.id !== draftState.refereeId) return;
    const match = votingState.votingMatches.find(m => String(m.matchId) === String(matchId));
    if (match) {
      match.status = newStatus;
      // Sync back to savedLiveSessions if Type A
      const session = draftState.savedLiveSessions.find(s => String(s.matchId) === String(matchId));
      if (session) session.status = newStatus;
    }
    broadcastState();
  });

  // ── Voting: Refresh match list ─────────────────────────────────────────────
  socket.on('refRefreshVotingMatches', async () => {
    if (socket.id !== draftState.refereeId) return;
    await refreshVotingMatches();
  });

  // ── Voting: Get Ballots (Ref only) ─────────────────────────────────────────
  socket.on('refGetBallots', ({ matchId } = {}) => {
    if (socket.id !== draftState.refereeId) return;
    const ballots = votingState.ballots[matchId] || [];
    socket.emit('refBallotData', { matchId, ballots });
  });

  // ── NEW Feature 2: Fan Submit Ballot with anti-double-vote ────────────────
  socket.on('fanSubmitBallot', ({ txId, matchId, coachVote, scores } = {}) => {
    // Gate 1: Master voting gate
    if (!draftState.votingAllowed) {
      socket.emit('ballotResult', { success: false, error: 'VOTING_LOCKED' });
      return;
    }
    // Gate 2: Match must exist and be OPEN
    const match = votingState.votingMatches.find(m => String(m.matchId) === String(matchId));
    if (!match || match.status !== 'OPEN') {
      socket.emit('ballotResult', { success: false, error: 'MATCH_CLOSED' });
      return;
    }
    // Gate 3: Verify ticket
    const voter = draftState.allViewers.find(v => v.txId === txId);
    if (!voter) {
      socket.emit('ballotResult', { success: false, error: 'NOT_VERIFIED' });
      return;
    }
    // Gate 4: Anti-double vote
    if (!votingState.voteRegistry[matchId]) votingState.voteRegistry[matchId] = new Set();
    if (votingState.voteRegistry[matchId].has(txId)) {
      socket.emit('ballotResult', { success: false, error: 'ALREADY_VOTED' });
      return;
    }
    // Record vote
    votingState.voteRegistry[matchId].add(txId);
    if (!votingState.ballots[matchId]) votingState.ballots[matchId] = [];
    votingState.ballots[matchId].push({ txId, coachVote, scores, submittedAt: Date.now() });
    socket.emit('ballotResult', { success: true });
    broadcastState();
  });

  // ── Player: Pick card ──────────────────────────────────────────────────────
  socket.on('playerPickCard', (cardId) => {
    const viewer = draftState.allViewers.find(v => v.id === socket.id);
    if (!viewer || !draftState.gameStarted || draftState.matchLocked) return;
    if (viewer.role !== draftState.currentTurn) return;
    const cardIdx = draftState.availableCards.findIndex(c => String(c.id || c.Id) === String(cardId));
    if (cardIdx === -1) return;
    const [card] = draftState.availableCards.splice(cardIdx, 1);
    if (draftState.currentTurn === 'team1') {
      draftState.team1Picks.push(card);
      draftState.currentTurn = 'team2';
    } else {
      draftState.team2Picks.push(card);
      draftState.currentTurn = 'team1';
    }
    broadcastState();
  });

  // ── Player: Set position ───────────────────────────────────────────────────
  socket.on('playerSetPosition', ({ cardId, slotIndex } = {}) => {
    const viewer = draftState.allViewers.find(v => v.id === socket.id);
    if (!viewer) return;
    const targetTactics = viewer.role === 'team1' ? draftState.team1Tactics : draftState.team2Tactics;
    targetTactics[slotIndex] = draftState[viewer.role === 'team1' ? 'team1Picks' : 'team2Picks']
      .find(c => String(c.id || c.Id) === String(cardId)) || null;
    broadcastState();
  });

  // ── Player: Set formation ──────────────────────────────────────────────────
  socket.on('playerSetFormation', ({ team, formation } = {}) => {
    const viewer = draftState.allViewers.find(v => v.id === socket.id);
    if (!viewer) return;
    if (viewer.role === 'team1' && team === 'team1') draftState.team1Formation = formation;
    if (viewer.role === 'team2' && team === 'team2') draftState.team2Formation = formation;
    broadcastState();
  });

  // ── Clear Arena (ULTIMATE — full wipe) ────────────────────────────────────
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
    };
    votingState = { votingMatches: [], voteRegistry: {}, ballots: {} };
    io.emit('clearArenaForce');
    broadcastState();
  });

  // ── Handle disconnect ──────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    // Do NOT remove viewers on disconnect — they may refresh.
    // Their socket ID will be updated on rejoin (Feature 6).
  });
});

// ── Initial data load & periodic refresh ──────────────────────────────────────
(async () => {
  await refreshVotingMatches();
  setInterval(refreshVotingMatches, 5 * 60 * 1000); // Refresh every 5 minutes
})();

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
