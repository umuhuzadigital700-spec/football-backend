// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

// ── Unique Match ID generator ─────────────────────────────────────────────────
let liveMatchCounter = 0;
function nextLiveMatchId() {
  liveMatchCounter += 1;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 12);
  const seq = String(liveMatchCounter).padStart(3, '0');
  return `MATCH-LIVE-${seq}-${ts}`;
}

// ── Persistent storage collections (survive resets, not full purge) ──────────
let savedLiveSessions = [];    // Type A — persisted across team resets
let votingMatches = [];        // All matches (A + B) served to fans
let voteRegistry = {};         // { matchId: [txId, ...] }
let typeAStats = {};           // { matchId: { team1Votes, team2Votes } }
let typeBStats = {};           // { matchId: { participantName: avgScore } }
let typeBBallots = {};         // { matchId: [ { txId, scores } ] }
let typeABallots = {};         // { matchId: [ { txId, teamVote } ] }

// ── Volatile game state (reset on refReset / refRestart / refClearArena) ─────
function freshGameState() {
  return {
    // Lobby
    allViewers: [],
    gameStarted: false,
    roomPhase: 'LOBBY',
    votingAllowed: false,
    votingMode: 'BOTH',

    // Media
    arenaBanner: null,
    youtubeLink: null,
    qrCodes: ['', '', '', '', '', ''],

    // Teams
    team1Player: null,    // { socketId, txId, name, isPremium, secureLink }
    team2Player: null,
    team1Picks: [],
    team2Picks: [],
    team1Formation: '4-4-2',
    team2Formation: '4-4-2',
    team1Tactics: {},     // { slotIndex: playerCard }
    team2Tactics: {},

    // Drafting
    availableCards: [],
    currentTurn: 'team1',

    // Match state
    matchLocked: false,
    matchReady: false,

    // Voting references (references to persistent collections)
    votingMatches: [],
    voteRegistry: {},
    typeAStats: {},
    typeBStats: {},
    savedLiveSessions: [],
  };
}

let state = freshGameState();

// ── Helpers ───────────────────────────────────────────────────────────────────
function getPublicState() {
  return {
    ...state,
    votingMatches,
    voteRegistry,
    typeAStats,
    typeBStats,
    savedLiveSessions,
  };
}

function broadcast() {
  io.emit('gameStateUpdate', getPublicState());
}

function findViewerBySocket(socketId) {
  return state.allViewers.find(v => v.id === socketId);
}

function findViewerByTxId(txId) {
  return state.allViewers.find(v => v.txId === txId);
}

function recalcTypeBStats(matchId) {
  const ballots = typeBBallots[matchId] || [];
  if (ballots.length === 0) { typeBStats[matchId] = {}; return; }
  const totals = {};
  const counts = {};
  ballots.forEach(b => {
    Object.entries(b.scores || {}).forEach(([name, score]) => {
      totals[name] = (totals[name] || 0) + score;
      counts[name] = (counts[name] || 0) + 1;
    });
  });
  typeBStats[matchId] = {};
  Object.keys(totals).forEach(name => {
    typeBStats[matchId][name] = (totals[name] / counts[name]).toFixed(1);
  });
}

function recalcTypeAStats(matchId) {
  const ballots = typeABallots[matchId] || [];
  let t1 = 0; let t2 = 0;
  ballots.forEach(b => {
    if (b.teamVote === 'team1') t1++;
    else if (b.teamVote === 'team2') t2++;
  });
  typeAStats[matchId] = { team1Votes: t1, team2Votes: t2 };
}

// ── REFEREE token ─────────────────────────────────────────────────────────────
const REF_TOKEN = process.env.REF_TOKEN || 'REFEREE_2025';

// ── Player card data (loaded from file or in-memory default) ──────────────────
// In production you would load from a JSON file. Here we seed a minimal default.
let masterCardPool = [];
try {
  masterCardPool = require('./cards.json');
} catch (e) {
  masterCardPool = Array.from({ length: 50 }, (_, i) => ({
    id: `P${i + 1}`,
    name: `Player ${i + 1}`,
    position: ['GK', 'CB', 'LB', 'RB', 'CM', 'ST', 'LW', 'RW'][i % 8],
    rating: 70 + (i % 30),
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET EVENTS
// ══════════════════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // Send current state to new connection
  socket.emit('gameStateUpdate', getPublicState());

  // ── Join Waiting Room ──────────────────────────────────────────────────────
  socket.on('joinWaitingRoom', ({ name, ticketCode }) => {
    if (!name || !ticketCode) return;
    const txId = String(ticketCode).trim();
    const existing = findViewerByTxId(txId);
    if (existing) {
      existing.id = socket.id;
      socket.emit('gameStateUpdate', getPublicState());
      return;
    }
    const viewer = {
      id: socket.id,
      txId,
      name: String(name).trim(),
      role: 'spectator',
      isPremium: false,
      secureLink: null,
    };
    state.allViewers.push(viewer);
    broadcast();
  });

  // ── Claim Referee ──────────────────────────────────────────────────────────
  socket.on('claimReferee', (token) => {
    if (token !== REF_TOKEN) {
      socket.emit('refConfirm', false);
      socket.emit('error', 'Invalid referee token.');
      return;
    }
    socket.emit('refConfirm', true);
    socket.emit('gameStateUpdate', getPublicState());
    console.log(`[ref] Claimed by ${socket.id}`);
  });

  // ── Referee: Assign Role ───────────────────────────────────────────────────
  socket.on('refAssignRole', ({ userId, role }) => {
    const viewer = state.allViewers.find(v => v.id === userId);
    if (!viewer) return;
    viewer.role = role;
    if (role === 'team1') {
      state.team1Player = viewer;
    } else if (role === 'team2') {
      state.team2Player = viewer;
    }
    broadcast();
  });

  // ── Referee: Start Draft ───────────────────────────────────────────────────
  socket.on('refStartDraft', () => {
    state.gameStarted = true;
    state.roomPhase = 'DRAFT';
    state.matchLocked = false;
    state.matchReady = false;
    state.team1Picks = [];
    state.team2Picks = [];
    state.team1Tactics = {};
    state.team2Tactics = {};
    state.currentTurn = 'team1';

    // Shuffle master pool for fresh draft
    state.availableCards = [...masterCardPool].sort(() => Math.random() - 0.5);
    io.emit('gameSyncPhase', 'DRAFT');
    broadcast();
  });

  // ── Referee: Lock Match ────────────────────────────────────────────────────
  socket.on('refLockMatch', () => {
    state.matchLocked = true;
    broadcast();
  });

  // ── Referee: Mark Match Ready (full position lockout) ─────────────────────
  socket.on('refMatchReady', () => {
    state.matchReady = true;
    state.matchLocked = true;
    socket.emit('refMatchReady_ack', { success: true });
    broadcast();
  });

  // ── Referee: Save Live Session ─────────────────────────────────────────────
  // Creates a Type A voting entry with unique MATCH-LIVE-NNN ID and snapshot.
  socket.on('refSaveLiveSession', () => {
    if (!state.matchReady) {
      socket.emit('refSaveLiveSession_ack', { success: false, error: 'Match must be marked Ready before saving.' });
      return;
    }

    const coach1Name = state.team1Player?.name || 'Team 1 Coach';
    const coach2Name = state.team2Player?.name || 'Team 2 Coach';
    const sessionName = `${coach1Name} / Team 1 vs ${coach2Name} / Team 2`;
    const matchId = nextLiveMatchId();

    const entry = {
      matchId,
      name: sessionName,
      matchType: 'A',
      status: 'OPEN',
      coach1: coach1Name,
      coach2: coach2Name,
      team1Picks: JSON.parse(JSON.stringify(state.team1Picks)),
      team2Picks: JSON.parse(JSON.stringify(state.team2Picks)),
      team1Formation: state.team1Formation,
      team2Formation: state.team2Formation,
      t1Tactics: JSON.parse(JSON.stringify(state.team1Tactics)),
      t2Tactics: JSON.parse(JSON.stringify(state.team2Tactics)),
      savedAt: new Date().toISOString(),
    };

    savedLiveSessions.push(entry);
    votingMatches.push(entry);
    typeABallots[matchId] = [];
    typeAStats[matchId] = { team1Votes: 0, team2Votes: 0 };
    voteRegistry[matchId] = [];

    socket.emit('refSaveLiveSession_ack', { success: true, matchId, sessionName });
    broadcast();
  });

  // ── Referee: Toggle Voting Status ─────────────────────────────────────────
  socket.on('refToggleVotingStatus', ({ matchId, newStatus }) => {
    const match = votingMatches.find(m => m.matchId === matchId);
    if (match) match.status = newStatus;
    const savedMatch = savedLiveSessions.find(m => m.matchId === matchId);
    if (savedMatch) savedMatch.status = newStatus;
    broadcast();
  });

  // ── Referee: Toggle Voting Gate ───────────────────────────────────────────
  socket.on('refToggleVotingGate', ({ allowed, mode }) => {
    state.votingAllowed = !!allowed;
    state.votingMode = mode || 'BOTH';
    if (allowed) {
      io.emit('gameSyncPhase', 'VOTING');
    }
    broadcast();
  });

  // ── Referee: Refresh Voting Matches ───────────────────────────────────────
  socket.on('refRefreshVotingMatches', () => {
    socket.emit('gameStateUpdate', getPublicState());
  });

  // ── Referee: Get Ballots ───────────────────────────────────────────────────
  socket.on('refGetBallots', ({ matchId }) => {
    const match = votingMatches.find(m => m.matchId === matchId);
    if (!match) { socket.emit('refBallotData', { matchId, ballots: [] }); return; }
    if (match.matchType === 'A') {
      socket.emit('refBallotData', {
        matchId,
        ballots: (typeABallots[matchId] || []).map(b => ({ txId: b.txId, teamVote: b.teamVote })),
      });
    } else {
      socket.emit('refBallotData', {
        matchId,
        ballots: (typeBBallots[matchId] || []).map(b => ({ txId: b.txId, scores: b.scores })),
      });
    }
  });

  // ── Referee: Reset (re-appoint new players, preserve sessions) ────────────
  socket.on('refReset', () => {
    // Clear team assignments only — saved sessions & voting data persist
    state.team1Player = null;
    state.team2Player = null;
    state.team1Picks = [];
    state.team2Picks = [];
    state.team1Tactics = {};
    state.team2Tactics = {};
    state.team1Formation = '4-4-2';
    state.team2Formation = '4-4-2';
    state.currentTurn = 'team1';
    state.gameStarted = false;
    state.roomPhase = 'LOBBY';
    state.matchLocked = false;
    state.matchReady = false;
    state.availableCards = [];
    state.allViewers.forEach(v => { v.role = 'spectator'; });
    io.emit('gameSyncPhase', 'LOBBY');
    broadcast();
  });

  // ── Referee: Restart (same players, fresh draft round) ────────────────────
  socket.on('refRestart', () => {
    state.team1Picks = [];
    state.team2Picks = [];
    state.team1Tactics = {};
    state.team2Tactics = {};
    state.currentTurn = 'team1';
    state.matchLocked = false;
    state.matchReady = false;
    state.availableCards = [...masterCardPool].sort(() => Math.random() - 0.5);
    io.emit('gameSyncPhase', 'DRAFT');
    broadcast();
  });

  // ── Referee: Clear Arena (full purge of ALL collections) ─────────────────
  socket.on('refClearArena', () => {
    // Purge everything including persistent collections
    savedLiveSessions = [];
    votingMatches = [];
    voteRegistry = {};
    typeAStats = {};
    typeBStats = {};
    typeBBallots = {};
    typeABallots = {};
    liveMatchCounter = 0;
    state = freshGameState();
    io.emit('clearArenaForce');
    broadcast();
    console.log('[ref] Arena cleared.');
  });

  // ── Referee: Set Arena Banner ─────────────────────────────────────────────
  socket.on('refSetBanner', (url) => {
    state.arenaBanner = url;
    broadcast();
  });

  // ── Referee: Set YouTube Link ─────────────────────────────────────────────
  socket.on('refSetYoutube', (url) => {
    state.youtubeLink = url;
    broadcast();
  });

  // ── Referee: Set QR Codes ─────────────────────────────────────────────────
  socket.on('refSetQRCodes', (qrs) => {
    if (Array.isArray(qrs)) state.qrCodes = qrs;
    broadcast();
  });

  // ── Referee: Load Type B Matches (from external spreadsheet data) ─────────
  // Expects an array of match objects, each named by sheet tab name.
  socket.on('refLoadTypeBMatches', (matches) => {
    if (!Array.isArray(matches)) return;
    matches.forEach(m => {
      const matchId = m.matchId || m.tabName || m.name;
      if (!matchId) return;
      if (votingMatches.find(ex => ex.matchId === matchId)) return; // no duplicate
      const entry = { ...m, matchId, matchType: 'B', status: m.status || 'CLOSED' };
      votingMatches.push(entry);
      typeBBallots[matchId] = [];
      typeBStats[matchId] = {};
      voteRegistry[matchId] = [];
    });
    broadcast();
  });

  // ── Player: Pick Card ──────────────────────────────────────────────────────
  socket.on('playerPickCard', (cardId) => {
    if (!state.gameStarted || state.matchReady) return;
    const viewer = findViewerBySocket(socket.id);
    if (!viewer) return;
    const team = viewer.role;
    if (team !== 'team1' && team !== 'team2') return;
    if (state.currentTurn !== team) return;

    const myPicks = team === 'team1' ? state.team1Picks : state.team2Picks;

    // §1.1: Roster cap — no more than 11 cards
    if (myPicks.length >= 11) {
      socket.emit('error', 'Your roster is full (11/11).');
      return;
    }

    const strId = String(cardId);

    // §1.2: Card must not be already picked by either team
    const alreadyPicked =
      state.team1Picks.some(c => String(c.id) === strId) ||
      state.team2Picks.some(c => String(c.id) === strId);
    if (alreadyPicked) {
      socket.emit('error', 'Card already picked.');
      return;
    }

    // §1.2: Remove from available pool immediately
    const cardIndex = state.availableCards.findIndex(c => String(c.id) === strId);
    if (cardIndex === -1) {
      socket.emit('error', 'Card not found in pool.');
      return;
    }
    const [card] = state.availableCards.splice(cardIndex, 1);
    myPicks.push(card);

    // Alternate turns
    state.currentTurn = team === 'team1' ? 'team2' : 'team1';
    broadcast();
  });

  // ── Player: Set Formation ──────────────────────────────────────────────────
  socket.on('playerSetFormation', ({ team, formation }) => {
    if (state.matchReady) return;
    const viewer = findViewerBySocket(socket.id);
    if (!viewer || viewer.role !== team) return;
    if (team === 'team1') state.team1Formation = formation;
    else state.team2Formation = formation;
    broadcast();
  });

  // ── Player: Set Position ───────────────────────────────────────────────────
  // §2.2: Single Positioning Invariant — placing card unsets its previous slot
  socket.on('playerSetPosition', ({ cardId, slotIndex }) => {
    if (state.matchReady) return;
    const viewer = findViewerBySocket(socket.id);
    if (!viewer) return;
    const team = viewer.role;
    if (team !== 'team1' && team !== 'team2') return;

    const myPicks = team === 'team1' ? state.team1Picks : state.team2Picks;
    const myTactics = team === 'team1' ? state.team1Tactics : state.team2Tactics;
    const strId = String(cardId);

    // Validate card is in this team's picks
    if (!myPicks.some(c => String(c.id) === strId)) {
      socket.emit('error', 'Card not in your roster.');
      return;
    }

    // §2.2: Remove card from any slot it currently occupies
    Object.keys(myTactics).forEach(slot => {
      if (myTactics[slot] && String(myTactics[slot].id) === strId) {
        delete myTactics[slot];
      }
    });

    // §2.2: If another card is in the target slot, unset that slot
    if (myTactics[slotIndex]) {
      delete myTactics[slotIndex];
    }

    // Place card in new slot
    const card = myPicks.find(c => String(c.id) === strId);
    myTactics[slotIndex] = card;

    if (team === 'team1') state.team1Tactics = myTactics;
    else state.team2Tactics = myTactics;

    broadcast();
  });

  // ── Fan: Submit Ballot ────────────────────────────────────────────────────
  // §3.1 Anti-fraud: one vote per txId per matchId, both Type A and B
  socket.on('fanSubmitBallot', ({ txId, matchId, teamVote, scores, matchType }) => {
    if (!state.votingAllowed) {
      socket.emit('ballotResult', { success: false, error: 'VOTING_LOCKED' });
      return;
    }

    const match = votingMatches.find(m => m.matchId === matchId);
    if (!match || match.status !== 'OPEN') {
      socket.emit('ballotResult', { success: false, error: 'MATCH_CLOSED' });
      return;
    }

    // Mode check
    const mode = state.votingMode || 'BOTH';
    if (mode !== 'BOTH' && match.matchType !== mode) {
      socket.emit('ballotResult', { success: false, error: 'MODE_NOT_OPEN' });
      return;
    }

    // Anti-fraud: no double votes
    if (!voteRegistry[matchId]) voteRegistry[matchId] = [];
    if (voteRegistry[matchId].includes(txId)) {
      socket.emit('ballotResult', { success: false, error: 'ALREADY_VOTED' });
      return;
    }

    // Verify fan is in lobby
    const fan = findViewerByTxId(txId);
    if (!fan) {
      socket.emit('ballotResult', { success: false, error: 'NOT_VERIFIED' });
      return;
    }

    voteRegistry[matchId].push(txId);

    if (matchType === 'A' || match.matchType === 'A') {
      if (!typeABallots[matchId]) typeABallots[matchId] = [];
      typeABallots[matchId].push({ txId, teamVote, timestamp: Date.now() });
      recalcTypeAStats(matchId);
    } else {
      if (!typeBBallots[matchId]) typeBBallots[matchId] = [];
      typeBBallots[matchId].push({ txId, scores: scores || {}, timestamp: Date.now() });
      recalcTypeBStats(matchId);
    }

    socket.emit('ballotResult', { success: true });
    broadcast();
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    // Keep viewer in list — they can rejoin with same txId
    console.log(`[disconnect] ${socket.id}`);
  });
});

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  res.json(getPublicState());
});

app.get('/api/matches', (req, res) => {
  res.json(votingMatches);
});

app.get('/api/ballots/:matchId', (req, res) => {
  const { matchId } = req.params;
  const match = votingMatches.find(m => m.matchId === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.matchType === 'A') {
    res.json({ ballots: typeABallots[matchId] || [], stats: typeAStats[matchId] || {} });
  } else {
    res.json({ ballots: typeBBallots[matchId] || [], stats: typeBStats[matchId] || {} });
  }
});

// ── Serve React frontend in production ────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🏟️  Arena server running on port ${PORT}`);
});
