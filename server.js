// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());

let liveMatchCounter = 0;
function nextLiveMatchId() {
  liveMatchCounter += 1;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 12);
  return 'MATCH-LIVE-' + String(liveMatchCounter).padStart(3, '0') + '-' + ts;
}

let savedLiveSessions = [];
let votingMatches = [];
let voteRegistry = {};
let typeAStats = {};
let typeBStats = {};
let typeBBallots = {};
let typeABallots = {};

function freshGameState() {
  return {
    allViewers: [],
    gameStarted: false,
    roomPhase: 'LOBBY',
    votingAllowed: false,
    votingMode: 'BOTH',
    arenaBanner: null,
    youtubeLink: null,
    qrCodes: ['', '', '', '', '', ''],
    team1Player: null,
    team2Player: null,
    team1Picks: [],
    team2Picks: [],
    team1Formation: '4-4-2',
    team2Formation: '4-4-2',
    team1Tactics: {},
    team2Tactics: {},
    availableCards: [],
    currentTurn: 'team1',
    matchLocked: false,
    matchReady: false,
  };
}

let state = freshGameState();

function getPublicState() {
  return { ...state, votingMatches, voteRegistry, typeAStats, typeBStats, savedLiveSessions };
}

function broadcast() {
  io.emit('gameStateUpdate', getPublicState());
}

function findViewerBySocket(socketId) { return state.allViewers.find(function(v) { return v.id === socketId; }); }
function findViewerByTxId(txId) { return state.allViewers.find(function(v) { return v.txId === txId; }); }

function recalcTypeBStats(matchId) {
  const ballots = typeBBallots[matchId] || [];
  if (ballots.length === 0) { typeBStats[matchId] = {}; return; }
  const totals = {}, counts = {};
  ballots.forEach(function(b) {
    Object.entries(b.scores || {}).forEach(function(pair) {
      totals[pair[0]] = (totals[pair[0]] || 0) + pair[1];
      counts[pair[0]] = (counts[pair[0]] || 0) + 1;
    });
  });
  typeBStats[matchId] = {};
  Object.keys(totals).forEach(function(name) { typeBStats[matchId][name] = (totals[name] / counts[name]).toFixed(1); });
}

function recalcTypeAStats(matchId) {
  const ballots = typeABallots[matchId] || [];
  let t1 = 0, t2 = 0;
  ballots.forEach(function(b) { if (b.teamVote === 'team1') t1++; else if (b.teamVote === 'team2') t2++; });
  typeAStats[matchId] = { team1Votes: t1, team2Votes: t2 };
}

const REF_TOKEN = process.env.REF_TOKEN || 'REFEREE_2025';
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || '';

let masterCardPool = [];
try { masterCardPool = require('./cards.json'); }
catch (e) {
  masterCardPool = Array.from({ length: 50 }, function(_, i) {
    return { id: 'P' + (i + 1), name: 'Player ' + (i + 1), position: ['GK','CB','LB','RB','CM','ST','LW','RW'][i % 8], rating: 70 + (i % 30) };
  });
}

// ── Verify payment via Google Apps Script ─────────────────────────────────────
async function verifyPayment(txId, name) {
  if (!APPS_SCRIPT_URL) {
    // No URL set: allow everyone (dev mode)
    console.log('[verify] No APPS_SCRIPT_URL set — allowing all in dev mode');
    return { success: true, isPremium: false };
  }
  try {
    const url = APPS_SCRIPT_URL + '?action=verify&txId=' + encodeURIComponent(txId) + '&name=' + encodeURIComponent(name);
    const resp = await fetch(url);
    const data = await resp.json();
    return { success: !!data.success, isPremium: !!data.isPremium, error: data.error || 'Payment not found' };
  } catch (err) {
    console.error('[verify] Error:', err.message);
    return { success: false, error: 'Verification service unavailable' };
  }
}

io.on('connection', function(socket) {
  console.log('[connect] ' + socket.id);
  socket.emit('gameStateUpdate', getPublicState());

  // ── Join Waiting Room ───────────────────────────────────────────────────────
  socket.on('joinWaitingRoom', async function(data) {
    const name = data && data.name ? String(data.name).trim() : '';
    const txId = data && data.ticketCode ? String(data.ticketCode).trim() : '';

    if (!name || !txId) {
      socket.emit('joinResult', { success: false, error: 'Name and transaction ID are required.' });
      return;
    }

    // If already joined (reconnect)
    const existing = findViewerByTxId(txId);
    if (existing) {
      existing.id = socket.id;
      socket.emit('joinResult', { success: true, isPremium: existing.isPremium });
      socket.emit('gameStateUpdate', getPublicState());
      return;
    }

    // Verify payment
    const result = await verifyPayment(txId, name);
    if (!result.success) {
      socket.emit('joinResult', { success: false, error: result.error || 'Payment not found. Check your MoMo transaction ID.' });
      return;
    }

    const viewer = { id: socket.id, txId: txId, name: name, role: 'spectator', isPremium: !!result.isPremium, secureLink: null };
    state.allViewers.push(viewer);
    socket.emit('joinResult', { success: true, isPremium: viewer.isPremium });
    broadcast();
  });

  // ── Claim Referee ───────────────────────────────────────────────────────────
  socket.on('claimReferee', function(token) {
    if (token !== REF_TOKEN) { socket.emit('refConfirm', false); return; }
    socket.emit('refConfirm', true);
    socket.emit('gameStateUpdate', getPublicState());
    console.log('[ref] Claimed by ' + socket.id);
  });

  // ── Referee: Assign Role ────────────────────────────────────────────────────
  socket.on('refAssignRole', function(data) {
    const viewer = state.allViewers.find(function(v) { return v.id === data.userId; });
    if (!viewer) return;
    viewer.role = data.role;
    if (data.role === 'team1') state.team1Player = viewer;
    else if (data.role === 'team2') state.team2Player = viewer;
    broadcast();
  });

  socket.on('refStartDraft', function() {
    state.gameStarted = true;
    state.roomPhase = 'DRAFT';
    state.matchLocked = false;
    state.matchReady = false;
    state.team1Picks = [];
    state.team2Picks = [];
    state.team1Tactics = {};
    state.team2Tactics = {};
    state.currentTurn = 'team1';
    state.availableCards = [...masterCardPool].sort(function() { return Math.random() - 0.5; });
    io.emit('gameSyncPhase', 'DRAFT');
    broadcast();
  });

  socket.on('refLockMatch', function() { state.matchLocked = true; broadcast(); });

  socket.on('refMatchReady', function() {
    state.matchReady = true;
    state.matchLocked = true;
    socket.emit('refMatchReady_ack', { success: true });
    broadcast();
  });

  socket.on('refSaveLiveSession', function() {
    if (!state.matchReady) { socket.emit('refSaveLiveSession_ack', { success: false, error: 'Match must be marked Ready first.' }); return; }
    const coach1Name = state.team1Player ? state.team1Player.name : 'Team 1 Coach';
    const coach2Name = state.team2Player ? state.team2Player.name : 'Team 2 Coach';
    const matchId = nextLiveMatchId();
    const entry = {
      matchId: matchId, name: coach1Name + ' / Team 1 vs ' + coach2Name + ' / Team 2',
      matchType: 'A', status: 'OPEN', coach1: coach1Name, coach2: coach2Name,
      team1Picks: JSON.parse(JSON.stringify(state.team1Picks)),
      team2Picks: JSON.parse(JSON.stringify(state.team2Picks)),
      team1Formation: state.team1Formation, team2Formation: state.team2Formation,
      t1Tactics: JSON.parse(JSON.stringify(state.team1Tactics)),
      t2Tactics: JSON.parse(JSON.stringify(state.team2Tactics)),
      savedAt: new Date().toISOString(),
    };
    savedLiveSessions.push(entry);
    votingMatches.push(entry);
    typeABallots[matchId] = [];
    typeAStats[matchId] = { team1Votes: 0, team2Votes: 0 };
    voteRegistry[matchId] = [];
    socket.emit('refSaveLiveSession_ack', { success: true, matchId: matchId });
    broadcast();
  });

  socket.on('refToggleVotingStatus', function(data) {
    const m = votingMatches.find(function(x) { return x.matchId === data.matchId; });
    if (m) m.status = data.newStatus;
    const s = savedLiveSessions.find(function(x) { return x.matchId === data.matchId; });
    if (s) s.status = data.newStatus;
    broadcast();
  });

  socket.on('refToggleVotingGate', function(data) {
    state.votingAllowed = !!data.allowed;
    state.votingMode = data.mode || 'BOTH';
    if (data.allowed) io.emit('gameSyncPhase', 'VOTING');
    broadcast();
  });

  socket.on('refRefreshVotingMatches', function() { socket.emit('gameStateUpdate', getPublicState()); });

  socket.on('refGetBallots', function(data) {
    const match = votingMatches.find(function(m) { return m.matchId === data.matchId; });
    if (!match) { socket.emit('refBallotData', { matchId: data.matchId, ballots: [] }); return; }
    if (match.matchType === 'A') {
      socket.emit('refBallotData', { matchId: data.matchId, ballots: (typeABallots[data.matchId] || []).map(function(b) { return { txId: b.txId, teamVote: b.teamVote }; }) });
    } else {
      socket.emit('refBallotData', { matchId: data.matchId, ballots: (typeBBallots[data.matchId] || []).map(function(b) { return { txId: b.txId, scores: b.scores }; }) });
    }
  });

  socket.on('refReset', function() {
    state.team1Player = null; state.team2Player = null;
    state.team1Picks = []; state.team2Picks = [];
    state.team1Tactics = {}; state.team2Tactics = {};
    state.team1Formation = '4-4-2'; state.team2Formation = '4-4-2';
    state.currentTurn = 'team1'; state.gameStarted = false;
    state.roomPhase = 'LOBBY'; state.matchLocked = false;
    state.matchReady = false; state.availableCards = [];
    state.allViewers.forEach(function(v) { v.role = 'spectator'; });
    io.emit('gameSyncPhase', 'LOBBY');
    broadcast();
  });

  socket.on('refRestart', function() {
    state.team1Picks = []; state.team2Picks = [];
    state.team1Tactics = {}; state.team2Tactics = {};
    state.currentTurn = 'team1'; state.matchLocked = false; state.matchReady = false;
    state.availableCards = [...masterCardPool].sort(function() { return Math.random() - 0.5; });
    io.emit('gameSyncPhase', 'DRAFT');
    broadcast();
  });

  socket.on('refClearArena', function() {
    savedLiveSessions = []; votingMatches = []; voteRegistry = {};
    typeAStats = {}; typeBStats = {}; typeBBallots = {}; typeABallots = {};
    liveMatchCounter = 0; state = freshGameState();
    io.emit('clearArenaForce');
    broadcast();
    console.log('[ref] Arena cleared.');
  });

  socket.on('refSetBanner', function(url) { state.arenaBanner = url; broadcast(); });
  socket.on('refSetYoutube', function(url) { state.youtubeLink = url; broadcast(); });
  socket.on('refSetQRCodes', function(qrs) { if (Array.isArray(qrs)) state.qrCodes = qrs; broadcast(); });

  socket.on('refLoadTypeBMatches', function(matches) {
    if (!Array.isArray(matches)) return;
    matches.forEach(function(m) {
      const matchId = m.matchId || m.tabName || m.name;
      if (!matchId) return;
      if (votingMatches.find(function(ex) { return ex.matchId === matchId; })) return;
      const entry = Object.assign({}, m, { matchId: matchId, matchType: 'B', status: m.status || 'CLOSED' });
      votingMatches.push(entry);
      typeBBallots[matchId] = []; typeBStats[matchId] = {}; voteRegistry[matchId] = [];
    });
    broadcast();
  });

  socket.on('playerPickCard', function(cardId) {
    if (!state.gameStarted || state.matchReady) return;
    const viewer = findViewerBySocket(socket.id);
    if (!viewer) return;
    const team = viewer.role;
    if (team !== 'team1' && team !== 'team2') return;
    if (state.currentTurn !== team) return;
    const myPicks = team === 'team1' ? state.team1Picks : state.team2Picks;
    if (myPicks.length >= 11) { socket.emit('error', 'Your roster is full (11/11).'); return; }
    const strId = String(cardId);
    const alreadyPicked = state.team1Picks.some(function(c) { return String(c.id) === strId; }) || state.team2Picks.some(function(c) { return String(c.id) === strId; });
    if (alreadyPicked) { socket.emit('error', 'Card already picked.'); return; }
    const cardIndex = state.availableCards.findIndex(function(c) { return String(c.id) === strId; });
    if (cardIndex === -1) { socket.emit('error', 'Card not found in pool.'); return; }
    const card = state.availableCards.splice(cardIndex, 1)[0];
    myPicks.push(card);
    state.currentTurn = team === 'team1' ? 'team2' : 'team1';
    broadcast();
  });

  socket.on('playerSetFormation', function(data) {
    if (state.matchReady) return;
    const viewer = findViewerBySocket(socket.id);
    if (!viewer || viewer.role !== data.team) return;
    if (data.team === 'team1') state.team1Formation = data.formation;
    else state.team2Formation = data.formation;
    broadcast();
  });

  socket.on('playerSetPosition', function(data) {
    if (state.matchReady) return;
    const viewer = findViewerBySocket(socket.id);
    if (!viewer) return;
    const team = viewer.role;
    if (team !== 'team1' && team !== 'team2') return;
    const myPicks = team === 'team1' ? state.team1Picks : state.team2Picks;
    const myTactics = team === 'team1' ? state.team1Tactics : state.team2Tactics;
    const strId = String(data.cardId);
    if (!myPicks.some(function(c) { return String(c.id) === strId; })) { socket.emit('error', 'Card not in your roster.'); return; }
    Object.keys(myTactics).forEach(function(slot) { if (myTactics[slot] && String(myTactics[slot].id) === strId) delete myTactics[slot]; });
    if (myTactics[data.slotIndex]) delete myTactics[data.slotIndex];
    const card = myPicks.find(function(c) { return String(c.id) === strId; });
    myTactics[data.slotIndex] = card;
    if (team === 'team1') state.team1Tactics = myTactics; else state.team2Tactics = myTactics;
    broadcast();
  });

  socket.on('fanSubmitBallot', function(data) {
    if (!state.votingAllowed) { socket.emit('ballotResult', { success: false, error: 'VOTING_LOCKED' }); return; }
    const match = votingMatches.find(function(m) { return m.matchId === data.matchId; });
    if (!match || match.status !== 'OPEN') { socket.emit('ballotResult', { success: false, error: 'MATCH_CLOSED' }); return; }
    const mode = state.votingMode || 'BOTH';
    if (mode !== 'BOTH' && match.matchType !== mode) { socket.emit('ballotResult', { success: false, error: 'MODE_NOT_OPEN' }); return; }
    if (!voteRegistry[data.matchId]) voteRegistry[data.matchId] = [];
    if (voteRegistry[data.matchId].includes(data.txId)) { socket.emit('ballotResult', { success: false, error: 'ALREADY_VOTED' }); return; }
    const fan = findViewerByTxId(data.txId);
    if (!fan) { socket.emit('ballotResult', { success: false, error: 'NOT_VERIFIED' }); return; }
    voteRegistry[data.matchId].push(data.txId);
    if (data.matchType === 'A' || match.matchType === 'A') {
      if (!typeABallots[data.matchId]) typeABallots[data.matchId] = [];
      typeABallots[data.matchId].push({ txId: data.txId, teamVote: data.teamVote, timestamp: Date.now() });
      recalcTypeAStats(data.matchId);
    } else {
      if (!typeBBallots[data.matchId]) typeBBallots[data.matchId] = [];
      typeBBallots[data.matchId].push({ txId: data.txId, scores: data.scores || {}, timestamp: Date.now() });
      recalcTypeBStats(data.matchId);
    }
    socket.emit('ballotResult', { success: true });
    broadcast();
  });

  socket.on('disconnect', function() { console.log('[disconnect] ' + socket.id); });
});

app.get('/api/state', function(req, res) { res.json(getPublicState()); });
app.get('/api/matches', function(req, res) { res.json(votingMatches); });
app.get('/api/ballots/:matchId', function(req, res) {
  const match = votingMatches.find(function(m) { return m.matchId === req.params.matchId; });
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.matchType === 'A') res.json({ ballots: typeABallots[req.params.matchId] || [], stats: typeAStats[req.params.matchId] || {} });
  else res.json({ ballots: typeBBallots[req.params.matchId] || [], stats: typeBStats[req.params.matchId] || {} });
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));
  app.get('*', function(req, res) { res.sendFile(path.join(__dirname, 'build', 'index.html')); });
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, function() { console.log('Arena server running on port ' + PORT); });
