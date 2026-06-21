// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());

// ── Google Sheets IDs ─────────────────────────────────────────────────────────
// Sheet 1: Draft Player Cards (columns: id, name, position, rating)
const PLAYERS_SHEET_ID = '1hZMQ1QRkY-W55IKVQGDFWKt7P2_vHtivTwMSmilXIuE';
// Sheet 2: Type B Voting Matches (each tab = one match, rows = participants)
const VOTING_SHEET_ID = '1JyJtTWC2VpXPsboVA-RVfe0LEeC7ll2jK8GV8P-jLIM';
// Sheet 3: Additional / backup sheet
const EXTRA_SHEET_ID = '1K1AFepyqCMKYSeoaQ40wn18_uRF4vLfA0ckPMZxcisg';

// ── Google Sheets CSV fetch helper ───────────────────────────────────────────
function fetchSheetCSV(sheetId, gid) {
  return new Promise((resolve, reject) => {
    const gidParam = gid ? `&gid=${gid}` : '';
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gidParam}`;
    https.get(url, (res) => {
      // Follow redirect
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, (res2) => {
          let data = '';
          res2.on('data', chunk => { data += chunk; });
          res2.on('end', () => resolve(data));
          res2.on('error', reject);
        }).on('error', reject);
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Fetch sheet metadata (tab names + gids) ──────────────────────────────────
function fetchSheetMeta(sheetId) {
  return new Promise((resolve, reject) => {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        // Extract sheet tab names and gids from the page source
        const tabs = [];
        const regex = /"name":"([^"]+)","index":\d+,"sheetId":(\d+)/g;
        let match;
        while ((match = regex.exec(data)) !== null) {
          tabs.push({ name: match[1], gid: match[2] });
        }
        resolve(tabs);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Parse CSV rows into objects ───────────────────────────────────────────────
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
}

// ── Unique Match ID generator ─────────────────────────────────────────────────
let liveMatchCounter = 0;
function nextLiveMatchId() {
  liveMatchCounter += 1;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 12);
  const seq = String(liveMatchCounter).padStart(3, '0');
  return `MATCH-LIVE-${seq}-${ts}`;
}

// ── Persistent storage ────────────────────────────────────────────────────────
let savedLiveSessions = [];
let votingMatches = [];
let voteRegistry = {};
let typeAStats = {};
let typeBStats = {};
let typeBBallots = {};
let typeABallots = {};

// ── Volatile game state ───────────────────────────────────────────────────────
function freshGameState() {
  return {
    allViewers: [], gameStarted: false, roomPhase: 'LOBBY',
    votingAllowed: false, votingMode: 'BOTH',
    arenaBanner: null, youtubeLink: null, qrCodes: ['', '', '', '', '', ''],
    team1Player: null, team2Player: null,
    team1Picks: [], team2Picks: [],
    team1Formation: '4-4-2', team2Formation: '4-4-2',
    team1Tactics: {}, team2Tactics: {},
    availableCards: [], currentTurn: 'team1',
    matchLocked: false, matchReady: false,
    votingMatches: [], voteRegistry: {}, typeAStats: {}, typeBStats: {}, savedLiveSessions: [],
  };
}

let state = freshGameState();

// ── Card pool: load from Sheets or fallback ───────────────────────────────────
let masterCardPool = [];
function loadFallbackCards() {
  try {
    masterCardPool = require('./cards.json');
    console.log(`[cards] Loaded ${masterCardPool.length} cards from cards.json`);
  } catch (e) {
    masterCardPool = Array.from({ length: 50 }, (_, i) => ({
      id: `P${i + 1}`,
      name: `Player ${i + 1}`,
      position: ['GK', 'CB', 'LB', 'RB', 'CM', 'ST', 'LW', 'RW'][i % 8],
      rating: 70 + (i % 30),
    }));
    console.log('[cards] Using fallback generated cards');
  }
}
loadFallbackCards();

// ── Load draft cards from Google Sheets ──────────────────────────────────────
async function loadDraftCardsFromSheets() {
  try {
    const csv = await fetchSheetCSV(PLAYERS_SHEET_ID);
    const rows = parseCSV(csv);
    if (rows.length === 0) throw new Error('No rows found in Players sheet');
    masterCardPool = rows.map((row, i) => ({
      id: row.id || row.Id || row.ID || String(i + 1),
      name: row.name || row.Name || row.player || row.Player || row['player name'] || `Player ${i + 1}`,
      position: row.position || row.Position || row.pos || row.Pos || '',
      rating: parseInt(row.rating || row.Rating || row.overall || '75', 10) || 75,
      team: row.team || row.Team || '',
      nationality: row.nationality || row.Nationality || '',
    }));
    console.log(`[sheets] Loaded ${masterCardPool.length} draft cards from Sheets`);
    return masterCardPool.length;
  } catch (err) {
    console.error('[sheets] Failed to load draft cards:', err.message);
    throw err;
  }
}

// ── Load Type B voting matches from Sheets ────────────────────────────────────
async function loadTypeBMatchesFromSheets(socket) {
  try {
    const tabs = await fetchSheetMeta(VOTING_SHEET_ID);
    if (tabs.length === 0) {
      // fallback: load first sheet only
      const csv = await fetchSheetCSV(VOTING_SHEET_ID);
      const rows = parseCSV(csv);
      const matchId = 'Match-Default';
      if (!votingMatches.find(m => m.matchId === matchId)) {
        const participants = rows.map(r => r.name || r.Name || r.player || r.participant || '').filter(Boolean);
        const entry = { matchId, name: matchId, matchType: 'B', status: 'CLOSED', participants };
        votingMatches.push(entry);
        typeBBallots[matchId] = [];
        typeBStats[matchId] = {};
        voteRegistry[matchId] = [];
      }
      return 1;
    }

    let count = 0;
    for (const tab of tabs) {
      const matchId = tab.name;
      if (votingMatches.find(m => m.matchId === matchId)) continue;
      try {
        const csv = await fetchSheetCSV(VOTING_SHEET_ID, tab.gid);
        const rows = parseCSV(csv);
        // Build participant list from rows — each row is one person
        const participants = rows.map(r => {
          const rawName = r.name || r.Name || r.player || r.Player || r.participant || r.Participant || '';
          const rawRole = r.role || r.Role || r.position || r.Position || r.category || r.Category || '';
          return rawName ? { name: rawName, role: rawRole } : null;
        }).filter(Boolean);

        const entry = {
          matchId,
          name: matchId,
          matchType: 'B',
          status: 'CLOSED',
          participants,
        };
        votingMatches.push(entry);
        typeBBallots[matchId] = [];
        typeBStats[matchId] = {};
        voteRegistry[matchId] = [];
        count++;
      } catch (tabErr) {
        console.warn(`[sheets] Could not load tab "${matchId}":`, tabErr.message);
      }
    }
    console.log(`[sheets] Loaded ${count} Type B matches from Voting Sheet`);
    return count;
  } catch (err) {
    console.error('[sheets] Failed to load voting matches:', err.message);
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getPublicState() {
  return { ...state, votingMatches, voteRegistry, typeAStats, typeBStats, savedLiveSessions };
}
function broadcast() { io.emit('gameStateUpdate', getPublicState()); }
function findViewerBySocket(socketId) { return state.allViewers.find(v => v.id === socketId); }
function findViewerByTxId(txId) { return state.allViewers.find(v => v.txId === txId); }

function recalcTypeBStats(matchId) {
  const ballots = typeBBallots[matchId] || [];
  if (ballots.length === 0) { typeBStats[matchId] = {}; return; }
  const totals = {}, counts = {};
  ballots.forEach(b => {
    Object.entries(b.scores || {}).forEach(([name, score]) => {
      totals[name] = (totals[name] || 0) + Number(score);
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
  let t1 = 0, t2 = 0;
  ballots.forEach(b => { if (b.teamVote === 'team1') t1++; else if (b.teamVote === 'team2') t2++; });
  typeAStats[matchId] = { team1Votes: t1, team2Votes: t2 };
}

// ── Referee token ─────────────────────────────────────────────────────────────
const REF_TOKEN = process.env.REF_TOKEN || 'REFEREE_2025';

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET EVENTS
// ══════════════════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  socket.emit('gameStateUpdate', getPublicState());

  // ── Join Waiting Room ──────────────────────────────────────────────────────
  socket.on('joinWaitingRoom', ({ name, ticketCode }) => {
    if (!name || !ticketCode) return;
    const txId = String(ticketCode).trim();
    const existing = findViewerByTxId(txId);
    if (existing) { existing.id = socket.id; socket.emit('gameStateUpdate', getPublicState()); return; }
    state.allViewers.push({ id: socket.id, txId, name: String(name).trim(), role: 'spectator', isPremium: false, secureLink: null });
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

  // ── Load Draft Cards from Sheets ───────────────────────────────────────────
  socket.on('refLoadDraftCards', async () => {
    try {
      const count = await loadDraftCardsFromSheets();
      socket.emit('sheetsLoaded', { count, type: 'cards' });
      console.log(`[ref] Draft cards reloaded: ${count} cards`);
    } catch (err) {
      socket.emit('sheetsLoaded', { count: 0, error: err.message });
    }
  });

  // ── Load Type B Matches from Sheets ───────────────────────────────────────
  socket.on('refLoadFromSheets', async () => {
    try {
      const count = await loadTypeBMatchesFromSheets(socket);
      socket.emit('sheetsLoaded', { count, type: 'matches' });
      broadcast();
    } catch (err) {
      socket.emit('sheetsLoaded', { count: 0, error: err.message });
    }
  });

  // ── Referee: Assign Role ───────────────────────────────────────────────────
  socket.on('refAssignRole', ({ userId, role }) => {
    const viewer = state.allViewers.find(v => v.id === userId);
    if (!viewer) return;
    viewer.role = role;
    if (role === 'team1') state.team1Player = viewer;
    else if (role === 'team2') state.team2Player = viewer;
    broadcast();
  });

  // ── Referee: Start Draft ───────────────────────────────────────────────────
  socket.on('refStartDraft', () => {
    state.gameStarted = true;
    state.roomPhase = 'DRAFT';
    state.matchLocked = false;
    state.matchReady = false;
    state.team1Picks = []; state.team2Picks = [];
    state.team1Tactics = {}; state.team2Tactics = {};
    state.currentTurn = 'team1';
    state.availableCards = [...masterCardPool].sort(() => Math.random() - 0.5);
    io.emit('gameSyncPhase', 'DRAFT');
    broadcast();
  });

  // ── Referee: Lock Match ────────────────────────────────────────────────────
  socket.on('refLockMatch', () => { state.matchLocked = true; broadcast(); });

  // ── Referee: Mark Match Ready ──────────────────────────────────────────────
  socket.on('refMatchReady', () => {
    state.matchReady = true;
    state.matchLocked = true;
    socket.emit('refMatchReady_ack', { success: true });
    broadcast();
  });

  // ── Referee: Save Live Session ─────────────────────────────────────────────
  socket.on('refSaveLiveSession', () => {
    if (!state.matchReady) {
      socket.emit('refSaveLiveSession_ack', { success: false, error: 'Match must be marked Ready first.' });
      return;
    }
    const coach1Name = state.team1Player?.name || 'Team 1 Coach';
    const coach2Name = state.team2Player?.name || 'Team 2 Coach';
    const sessionName = `${coach1Name} / Team 1 vs ${coach2Name} / Team 2`;
    const matchId = nextLiveMatchId();
    const entry = {
      matchId, name: sessionName, matchType: 'A', status: 'OPEN',
      coach1: coach1Name, coach2: coach2Name,
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
    socket.emit('refSaveLiveSession_ack', { success: true, matchId, sessionName });
    broadcast();
  });

  // ── Referee: Toggle Voting Status ─────────────────────────────────────────
  socket.on('refToggleVotingStatus', ({ matchId, newStatus }) => {
    const match = votingMatches.find(m => m.matchId === matchId);
    if (match) match.status = newStatus;
    const saved = savedLiveSessions.find(m => m.matchId === matchId);
    if (saved) saved.status = newStatus;
    broadcast();
  });

  // ── Referee: Toggle Voting Gate ───────────────────────────────────────────
  socket.on('refToggleVotingGate', ({ allowed, mode }) => {
    state.votingAllowed = !!allowed;
    state.votingMode = mode || 'BOTH';
    if (allowed) io.emit('gameSyncPhase', 'VOTING');
    broadcast();
  });

  // ── Referee: Refresh Voting Matches ───────────────────────────────────────
  socket.on('refRefreshVotingMatches', () => { socket.emit('gameStateUpdate', getPublicState()); });

  // ── Referee: Get Ballots ───────────────────────────────────────────────────
  socket.on('refGetBallots', ({ matchId }) => {
    const match = votingMatches.find(m => m.matchId === matchId);
    if (!match) { socket.emit('refBallotData', { matchId, ballots: [] }); return; }
    if (match.matchType === 'A') {
      socket.emit('refBallotData', { matchId, ballots: (typeABallots[matchId] || []).map(b => ({ txId: b.txId, teamVote: b.teamVote })) });
    } else {
      socket.emit('refBallotData', { matchId, ballots: (typeBBallots[matchId] || []).map(b => ({ txId: b.txId, scores: b.scores })) });
    }
  });

  // ── Referee: Reset ─────────────────────────────────────────────────────────
  socket.on('refReset', () => {
    state.team1Player = null; state.team2Player = null;
    state.team1Picks = []; state.team2Picks = [];
    state.team1Tactics = {}; state.team2Tactics = {};
    state.team1Formation = '4-4-2'; state.team2Formation = '4-4-2';
    state.currentTurn = 'team1'; state.gameStarted = false;
    state.roomPhase = 'LOBBY'; state.matchLocked = false; state.matchReady = false;
    state.availableCards = [];
    state.allViewers.forEach(v => { v.role = 'spectator'; });
    io.emit('gameSyncPhase', 'LOBBY');
    broadcast();
  });

  // ── Referee: Restart ───────────────────────────────────────────────────────
  socket.on('refRestart', () => {
    state.team1Picks = []; state.team2Picks = [];
    state.team1Tactics = {}; state.team2Tactics = {};
    state.currentTurn = 'team1'; state.matchLocked = false; state.matchReady = false;
    state.availableCards = [...masterCardPool].sort(() => Math.random() - 0.5);
    io.emit('gameSyncPhase', 'DRAFT');
    broadcast();
  });

  // ── Referee: Clear Arena ───────────────────────────────────────────────────
  socket.on('refClearArena', () => {
    savedLiveSessions = []; votingMatches = [];
    voteRegistry = {}; typeAStats = {}; typeBStats = {};
    typeBBallots = {}; typeABallots = {}; liveMatchCounter = 0;
    state = freshGameState();
    io.emit('clearArenaForce');
    broadcast();
    console.log('[ref] Arena cleared.');
  });

  // ── Referee: Set Banner ────────────────────────────────────────────────────
  socket.on('refSetBanner', (url) => { state.arenaBanner = url; broadcast(); });

  // ── Referee: Set YouTube ───────────────────────────────────────────────────
  socket.on('refSetYoutube', (url) => { state.youtubeLink = url; broadcast(); });

  // ── Referee: Set QR Codes ──────────────────────────────────────────────────
  socket.on('refSetQRCodes', (qrs) => { if (Array.isArray(qrs)) state.qrCodes = qrs; broadcast(); });

  // ── Referee: Load Type B Matches (manual array) ────────────────────────────
  socket.on('refLoadTypeBMatches', (matches) => {
    if (!Array.isArray(matches)) return;
    matches.forEach(m => {
      const matchId = m.matchId || m.tabName || m.name;
      if (!matchId || votingMatches.find(ex => ex.matchId === matchId)) return;
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
    if (myPicks.length >= 11) { socket.emit('error', 'Your roster is full (11/11).'); return; }
    const strId = String(cardId);
    const alreadyPicked = state.team1Picks.some(c => String(c.id) === strId) || state.team2Picks.some(c => String(c.id) === strId);
    if (alreadyPicked) { socket.emit('error', 'Card already picked.'); return; }
    const cardIndex = state.availableCards.findIndex(c => String(c.id) === strId);
    if (cardIndex === -1) { socket.emit('error', 'Card not found in pool.'); return; }
    const [card] = state.availableCards.splice(cardIndex, 1);
    myPicks.push(card);
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
  socket.on('playerSetPosition', ({ cardId, slotIndex }) => {
    if (state.matchReady) return;
    const viewer = findViewerBySocket(socket.id);
    if (!viewer) return;
    const team = viewer.role;
    if (team !== 'team1' && team !== 'team2') return;
    const myPicks = team === 'team1' ? state.team1Picks : state.team2Picks;
    const myTactics = team === 'team1' ? state.team1Tactics : state.team2Tactics;
    const strId = String(cardId);
    if (!myPicks.some(c => String(c.id) === strId)) { socket.emit('error', 'Card not in your roster.'); return; }
    Object.keys(myTactics).forEach(slot => {
      if (myTactics[slot] && String(myTactics[slot].id) === strId) delete myTactics[slot];
    });
    delete myTactics[slotIndex];
    const card = myPicks.find(c => String(c.id) === strId);
    myTactics[slotIndex] = card;
    if (team === 'team1') state.team1Tactics = myTactics;
    else state.team2Tactics = myTactics;
    broadcast();
  });

  // ── Fan: Submit Ballot ────────────────────────────────────────────────────
  socket.on('fanSubmitBallot', ({ txId, matchId, teamVote, scores, matchType }) => {
    if (!state.votingAllowed) { socket.emit('ballotResult', { success: false, error: 'VOTING_LOCKED' }); return; }
    const match = votingMatches.find(m => m.matchId === matchId);
    if (!match || match.status !== 'OPEN') { socket.emit('ballotResult', { success: false, error: 'MATCH_CLOSED' }); return; }
    const mode = state.votingMode || 'BOTH';
    if (mode !== 'BOTH' && match.matchType !== mode) { socket.emit('ballotResult', { success: false, error: 'MODE_NOT_OPEN' }); return; }
    if (!voteRegistry[matchId]) voteRegistry[matchId] = [];
    if (voteRegistry[matchId].includes(txId)) { socket.emit('ballotResult', { success: false, error: 'ALREADY_VOTED' }); return; }
    const fan = findViewerByTxId(txId);
    if (!fan) { socket.emit('ballotResult', { success: false, error: 'NOT_VERIFIED' }); return; }
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

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => { console.log(`[disconnect] ${socket.id}`); });
});

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => res.json(getPublicState()));
app.get('/api/matches', (req, res) => res.json(votingMatches));
app.get('/api/ballots/:matchId', (req, res) => {
  const { matchId } = req.params;
  const match = votingMatches.find(m => m.matchId === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.matchType === 'A') res.json({ ballots: typeABallots[matchId] || [], stats: typeAStats[matchId] || {} });
  else res.json({ ballots: typeBBallots[matchId] || [], stats: typeBStats[matchId] || {} });
});

// ── Serve React frontend in production ────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'build', 'index.html')));
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => { console.log(`🏟️  Arena server running on port ${PORT}`); });
