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

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — set these as environment variables on Render
// ══════════════════════════════════════════════════════════════════════════════
const REF_TOKEN         = process.env.REF_TOKEN         || 'REFEREE_2025';
const APPS_SCRIPT_URL   = process.env.APPS_SCRIPT_URL   || '';   // Google Apps Script web-app URL
const PLAYERS_SHEET_ID  = process.env.PLAYERS_SHEET_ID  || '1hZMQ1QRkY-W55IKVQGDFWKt7P2_vHtivTwMSmilXIuE';
const VOTING_SHEET_ID   = process.env.VOTING_SHEET_ID   || '1JyJtTWC2VpXPsboVA-RVfe0LEeC7ll2jK8GV8P-jLIM';

// ══════════════════════════════════════════════════════════════════════════════
// PAYMENT VERIFICATION — calls Google Apps Script doGet(e)
// Returns: { valid: true, amount: 300 }  or  { valid: false, message: "..." }
// ══════════════════════════════════════════════════════════════════════════════
function verifyPayment(txId, name) {
  return new Promise((resolve) => {
    if (!APPS_SCRIPT_URL) {
      // No script URL configured — allow everyone (dev mode)
      console.warn('[verify] APPS_SCRIPT_URL not set — skipping payment check (dev mode)');
      resolve({ valid: true, amount: 300, devMode: true });
      return;
    }
    const encoded = encodeURIComponent(txId);
    const encodedName = encodeURIComponent(name);
    const url = `${APPS_SCRIPT_URL}?code=${encoded}&name=${encodedName}`;

    function doGet(targetUrl) {
      const mod = targetUrl.startsWith('https') ? https : require('http');
      mod.get(targetUrl, { headers: { 'User-Agent': 'ArenaServer/1.0' } }, (res) => {
        // Follow redirects (Apps Script always redirects once)
        if (res.statusCode === 301 || res.statusCode === 302) {
          doGet(res.headers.location);
          return;
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            console.error('[verify] JSON parse error:', data);
            resolve({ valid: false, message: 'Verification service error.' });
          }
        });
        res.on('error', (err) => {
          console.error('[verify] HTTP error:', err.message);
          resolve({ valid: false, message: 'Network error during verification.' });
        });
      }).on('error', (err) => {
        console.error('[verify] Request error:', err.message);
        resolve({ valid: false, message: 'Could not reach verification service.' });
      });
    }
    doGet(url);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE SHEETS HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function fetchSheetCSV(sheetId, gid) {
  return new Promise((resolve, reject) => {
    const gidParam = gid ? `&gid=${gid}` : '';
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gidParam}`;
    function doGet(targetUrl) {
      https.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) { doGet(res.headers.location); return; }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    }
    doGet(url);
  });
}

function fetchSheetTabs(sheetId) {
  return new Promise((resolve, reject) => {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const tabs = [];
        const re = /"name":"([^"]+)","index":\d+,"sheetId":(\d+)/g;
        let m;
        while ((m = re.exec(data)) !== null) tabs.push({ name: m[1], gid: m[2] });
        resolve(tabs);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseCSV(csvText) {
  const lines = csvText.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.replace(/^"|"$/g, '').trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
}

async function loadDraftCardsFromSheets() {
  const csv = await fetchSheetCSV(PLAYERS_SHEET_ID);
  const rows = parseCSV(csv);
  if (rows.length === 0) throw new Error('No data in Players Sheet');
  masterCardPool = rows.map((row, i) => ({
    id: row.id || row.Id || row.ID || String(i + 1),
    name: row.name || row.Name || row['player name'] || row['player'] || `Player ${i + 1}`,
    position: row.position || row.Position || row.pos || '',
    rating: parseInt(row.rating || row.Rating || row.overall || '75', 10) || 75,
    team: row.team || row.Team || '',
  }));
  console.log('[sheets] Draft cards loaded:', masterCardPool.length);
  return masterCardPool.length;
}

async function loadTypeBMatchesFromSheets() {
  let tabs = [];
  try { tabs = await fetchSheetTabs(VOTING_SHEET_ID); } catch (e) { console.warn('[sheets] Tab list failed'); }
  if (tabs.length === 0) {
    const csv = await fetchSheetCSV(VOTING_SHEET_ID);
    const rows = parseCSV(csv);
    const matchId = 'Match-Sheet-1';
    if (!votingMatches.find(m => m.matchId === matchId)) {
      const participants = rows.map(r => ({ name: r.name || r.Name || '', role: r.role || r.position || '' })).filter(p => p.name);
      votingMatches.push({ matchId, name: matchId, matchType: 'B', status: 'CLOSED', participants });
      typeBBallots[matchId] = []; typeBStats[matchId] = {}; voteRegistry[matchId] = [];
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
      const participants = rows.map(r => ({ name: r.name || r.Name || r.participant || '', role: r.role || r.position || r.category || '' })).filter(p => p.name);
      votingMatches.push({ matchId, name: matchId, matchType: 'B', status: 'CLOSED', participants });
      typeBBallots[matchId] = []; typeBStats[matchId] = {}; voteRegistry[matchId] = [];
      count++;
    } catch (tabErr) { console.warn('[sheets] Tab error:', matchId); }
  }
  console.log('[sheets] Type B matches loaded:', count);
  return count;
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════
let liveMatchCounter = 0;
function nextLiveMatchId() {
  liveMatchCounter += 1;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 12);
  return `MATCH-LIVE-${String(liveMatchCounter).padStart(3, '0')}-${ts}`;
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

let masterCardPool = [];
try {
  masterCardPool = require('./cards.json');
  console.log('[cards] Loaded from cards.json:', masterCardPool.length);
} catch (e) {
  masterCardPool = Array.from({ length: 50 }, (_, i) => ({
    id: `P${i + 1}`, name: `Player ${i + 1}`,
    position: ['GK', 'CB', 'LB', 'RB', 'CM', 'ST', 'LW', 'RW'][i % 8],
    rating: 70 + (i % 30),
  }));
  console.log('[cards] Using fallback cards');
}

function getPublicState() {
  return { ...state, votingMatches, voteRegistry, typeAStats, typeBStats, savedLiveSessions };
}
function broadcast() { io.emit('gameStateUpdate', getPublicState()); }
function findViewerBySocket(id) { return state.allViewers.find(v => v.id === id); }
function findViewerByTxId(txId) { return state.allViewers.find(v => v.txId === txId); }

function recalcTypeBStats(matchId) {
  const ballots = typeBBallots[matchId] || [];
  if (!ballots.length) { typeBStats[matchId] = {}; return; }
  const totals = {}, counts = {};
  ballots.forEach(b => { Object.entries(b.scores || {}).forEach(([n, s]) => { totals[n] = (totals[n] || 0) + Number(s); counts[n] = (counts[n] || 0) + 1; }); });
  typeBStats[matchId] = {};
  Object.keys(totals).forEach(n => { typeBStats[matchId][n] = (totals[n] / counts[n]).toFixed(1); });
}
function recalcTypeAStats(matchId) {
  const ballots = typeABallots[matchId] || [];
  let t1 = 0, t2 = 0;
  ballots.forEach(b => { if (b.teamVote === 'team1') t1++; else if (b.teamVote === 'team2') t2++; });
  typeAStats[matchId] = { team1Votes: t1, team2Votes: t2 };
}

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET EVENTS
// ══════════════════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  socket.emit('gameStateUpdate', getPublicState());

  // ── JOIN WAITING ROOM — with payment verification ─────────────────────────
  socket.on('joinWaitingRoom', async ({ name, ticketCode }) => {
    if (!name || !ticketCode) {
      socket.emit('joinResult', { success: false, error: 'Name and ticket code are required.' });
      return;
    }
    const txId = String(ticketCode).trim();
    const safeName = String(name).trim();

    // Rejoin: same txId already in room
    const existing = findViewerByTxId(txId);
    if (existing) {
      existing.id = socket.id;
      socket.emit('joinResult', { success: true, isPremium: existing.isPremium });
      socket.emit('gameStateUpdate', getPublicState());
      return;
    }

    // Verify payment via Google Apps Script
    let verifyResult;
    try {
      verifyResult = await verifyPayment(txId, safeName);
    } catch (err) {
      socket.emit('joinResult', { success: false, error: 'Verification failed. Try again.' });
      return;
    }

    if (!verifyResult.valid) {
      socket.emit('joinResult', {
        success: false,
        error: verifyResult.message || 'Payment not found. Please check your MoMo transaction ID.',
      });
      return;
    }

    // Payment verified ✅
    const isPremium = (verifyResult.amount || 0) >= 500; // VIP tier if paid 500+ RWF
    const viewer = {
      id: socket.id,
      txId,
      name: safeName,
      role: 'spectator',
      isPremium,
      secureLink: null,
      paidAmount: verifyResult.amount || 0,
      joinedAt: new Date().toISOString(),
    };
    state.allViewers.push(viewer);
    socket.emit('joinResult', { success: true, isPremium, amount: verifyResult.amount });
    broadcast();
    console.log(`[join] ${safeName} (txId: ${txId}, amount: ${verifyResult.amount}, premium: ${isPremium})`);
  });

  // ── CLAIM REFEREE ─────────────────────────────────────────────────────────
  socket.on('claimReferee', (token) => {
    if (token !== REF_TOKEN) { socket.emit('refConfirm', false); socket.emit('error', 'Invalid referee token.'); return; }
    socket.emit('refConfirm', true);
    socket.emit('gameStateUpdate', getPublicState());
    console.log(`[ref] Claimed by ${socket.id}`);
  });

  // ── LOAD DRAFT CARDS FROM SHEETS ──────────────────────────────────────────
  socket.on('refLoadDraftCards', async () => {
    try {
      const count = await loadDraftCardsFromSheets();
      socket.emit('sheetsLoaded', { count, type: 'cards' });
    } catch (err) {
      socket.emit('sheetsLoaded', { count: 0, error: err.message });
    }
  });

  // ── LOAD TYPE B MATCHES FROM SHEETS ───────────────────────────────────────
  socket.on('refLoadFromSheets', async () => {
    try {
      const count = await loadTypeBMatchesFromSheets();
      socket.emit('sheetsLoaded', { count, type: 'matches' });
      broadcast();
    } catch (err) {
      socket.emit('sheetsLoaded', { count: 0, error: err.message });
    }
  });

  // ── REFEREE: ASSIGN ROLE ──────────────────────────────────────────────────
  socket.on('refAssignRole', ({ userId, role }) => {
    const viewer = state.allViewers.find(v => v.id === userId);
    if (!viewer) return;
    viewer.role = role;
    if (role === 'team1') state.team1Player = viewer;
    else if (role === 'team2') state.team2Player = viewer;
    broadcast();
  });

  // ── REFEREE: START DRAFT ──────────────────────────────────────────────────
  socket.on('refStartDraft', () => {
    state.gameStarted = true; state.roomPhase = 'DRAFT';
    state.matchLocked = false; state.matchReady = false;
    state.team1Picks = []; state.team2Picks = [];
    state.team1Tactics = {}; state.team2Tactics = {};
    state.currentTurn = 'team1';
    state.availableCards = [...masterCardPool].sort(() => Math.random() - 0.5);
    io.emit('gameSyncPhase', 'DRAFT');
    broadcast();
  });

  socket.on('refLockMatch', () => { state.matchLocked = true; broadcast(); });

  socket.on('refMatchReady', () => {
    state.matchReady = true; state.matchLocked = true;
    socket.emit('refMatchReady_ack', { success: true });
    broadcast();
  });

  socket.on('refSaveLiveSession', () => {
    if (!state.matchReady) { socket.emit('refSaveLiveSession_ack', { success: false, error: 'Mark match Ready first.' }); return; }
    const coach1 = state.team1Player?.name || 'Team 1 Coach';
    const coach2 = state.team2Player?.name || 'Team 2 Coach';
    const matchId = nextLiveMatchId();
    const entry = {
      matchId, name: `${coach1} / Team 1 vs ${coach2} / Team 2`,
      matchType: 'A', status: 'OPEN', coach1, coach2,
      team1Picks: JSON.parse(JSON.stringify(state.team1Picks)),
      team2Picks: JSON.parse(JSON.stringify(state.team2Picks)),
      team1Formation: state.team1Formation, team2Formation: state.team2Formation,
      t1Tactics: JSON.parse(JSON.stringify(state.team1Tactics)),
      t2Tactics: JSON.parse(JSON.stringify(state.team2Tactics)),
      savedAt: new Date().toISOString(),
    };
    savedLiveSessions.push(entry); votingMatches.push(entry);
    typeABallots[matchId] = []; typeAStats[matchId] = { team1Votes: 0, team2Votes: 0 }; voteRegistry[matchId] = [];
    socket.emit('refSaveLiveSession_ack', { success: true, matchId, sessionName: entry.name });
    broadcast();
  });

  socket.on('refToggleVotingStatus', ({ matchId, newStatus }) => {
    const m = votingMatches.find(m => m.matchId === matchId); if (m) m.status = newStatus;
    const s = savedLiveSessions.find(m => m.matchId === matchId); if (s) s.status = newStatus;
    broadcast();
  });

  socket.on('refToggleVotingGate', ({ allowed, mode }) => {
    state.votingAllowed = !!allowed; state.votingMode = mode || 'BOTH';
    if (allowed) io.emit('gameSyncPhase', 'VOTING');
    broadcast();
  });

  socket.on('refRefreshVotingMatches', () => socket.emit('gameStateUpdate', getPublicState()));

  socket.on('refGetBallots', ({ matchId }) => {
    const match = votingMatches.find(m => m.matchId === matchId);
    if (!match) { socket.emit('refBallotData', { matchId, ballots: [] }); return; }
    if (match.matchType === 'A') socket.emit('refBallotData', { matchId, ballots: (typeABallots[matchId] || []).map(b => ({ txId: b.txId, teamVote: b.teamVote })) });
    else socket.emit('refBallotData', { matchId, ballots: (typeBBallots[matchId] || []).map(b => ({ txId: b.txId, scores: b.scores })) });
  });

  socket.on('refReset', () => {
    state.team1Player = null; state.team2Player = null;
    state.team1Picks = []; state.team2Picks = [];
    state.team1Tactics = {}; state.team2Tactics = {};
    state.team1Formation = '4-4-2'; state.team2Formation = '4-4-2';
    state.currentTurn = 'team1'; state.gameStarted = false; state.roomPhase = 'LOBBY';
    state.matchLocked = false; state.matchReady = false; state.availableCards = [];
    state.allViewers.forEach(v => { v.role = 'spectator'; });
    io.emit('gameSyncPhase', 'LOBBY');
    broadcast();
  });

  socket.on('refRestart', () => {
    state.team1Picks = []; state.team2Picks = [];
    state.team1Tactics = {}; state.team2Tactics = {};
    state.currentTurn = 'team1'; state.matchLocked = false; state.matchReady = false;
    state.availableCards = [...masterCardPool].sort(() => Math.random() - 0.5);
    io.emit('gameSyncPhase', 'DRAFT');
    broadcast();
  });

  socket.on('refClearArena', () => {
    savedLiveSessions = []; votingMatches = []; voteRegistry = {};
    typeAStats = {}; typeBStats = {}; typeBBallots = {}; typeABallots = {}; liveMatchCounter = 0;
    state = freshGameState();
    io.emit('clearArenaForce');
    broadcast();
    console.log('[ref] Arena cleared.');
  });

  socket.on('refSetBanner', (url) => { state.arenaBanner = url; broadcast(); });
  socket.on('refSetYoutube', (url) => { state.youtubeLink = url; broadcast(); });
  socket.on('refSetQRCodes', (qrs) => { if (Array.isArray(qrs)) state.qrCodes = qrs; broadcast(); });

  socket.on('refLoadTypeBMatches', (matches) => {
    if (!Array.isArray(matches)) return;
    matches.forEach(m => {
      const matchId = m.matchId || m.tabName || m.name;
      if (!matchId || votingMatches.find(ex => ex.matchId === matchId)) return;
      votingMatches.push({ ...m, matchId, matchType: 'B', status: m.status || 'CLOSED' });
      typeBBallots[matchId] = []; typeBStats[matchId] = {}; voteRegistry[matchId] = [];
    });
    broadcast();
  });

  // ── PLAYER: PICK CARD ─────────────────────────────────────────────────────
  socket.on('playerPickCard', (cardId) => {
    if (!state.gameStarted || state.matchReady) return;
    const viewer = findViewerBySocket(socket.id);
    if (!viewer) return;
    const team = viewer.role;
    if (team !== 'team1' && team !== 'team2') return;
    if (state.currentTurn !== team) return;
    const myPicks = team === 'team1' ? state.team1Picks : state.team2Picks;
    if (myPicks.length >= 11) { socket.emit('error', 'Roster full (11/11).'); return; }
    const strId = String(cardId);
    if (state.team1Picks.some(c => String(c.id) === strId) || state.team2Picks.some(c => String(c.id) === strId)) { socket.emit('error', 'Card already picked.'); return; }
    const idx = state.availableCards.findIndex(c => String(c.id) === strId);
    if (idx === -1) { socket.emit('error', 'Card not available.'); return; }
    const [card] = state.availableCards.splice(idx, 1);
    myPicks.push(card);
    state.currentTurn = team === 'team1' ? 'team2' : 'team1';
    broadcast();
  });

  // ── PLAYER: SET FORMATION ─────────────────────────────────────────────────
  socket.on('playerSetFormation', ({ team, formation }) => {
    if (state.matchReady) return;
    const viewer = findViewerBySocket(socket.id);
    if (!viewer || viewer.role !== team) return;
    if (team === 'team1') state.team1Formation = formation;
    else state.team2Formation = formation;
    broadcast();
  });

  // ── PLAYER: SET POSITION ──────────────────────────────────────────────────
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
    Object.keys(myTactics).forEach(slot => { if (myTactics[slot] && String(myTactics[slot].id) === strId) delete myTactics[slot]; });
    delete myTactics[slotIndex];
    myTactics[slotIndex] = myPicks.find(c => String(c.id) === strId);
    if (team === 'team1') state.team1Tactics = myTactics;
    else state.team2Tactics = myTactics;
    broadcast();
  });

  // ── FAN: SUBMIT BALLOT ────────────────────────────────────────────────────
  socket.on('fanSubmitBallot', ({ txId, matchId, teamVote, scores, matchType }) => {
    if (!state.votingAllowed) { socket.emit('ballotResult', { success: false, error: 'VOTING_LOCKED' }); return; }
    const match = votingMatches.find(m => m.matchId === matchId);
    if (!match || match.status !== 'OPEN') { socket.emit('ballotResult', { success: false, error: 'MATCH_CLOSED' }); return; }
    const mode = state.votingMode || 'BOTH';
    if (mode !== 'BOTH' && match.matchType !== mode) { socket.emit('ballotResult', { success: false, error: 'MODE_NOT_OPEN' }); return; }
    if (!voteRegistry[matchId]) voteRegistry[matchId] = [];
    if (voteRegistry[matchId].includes(txId)) { socket.emit('ballotResult', { success: false, error: 'ALREADY_VOTED' }); return; }
    if (!findViewerByTxId(txId)) { socket.emit('ballotResult', { success: false, error: 'NOT_VERIFIED' }); return; }
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

  socket.on('disconnect', () => { console.log(`[disconnect] ${socket.id}`); });
});

// ══════════════════════════════════════════════════════════════════════════════
// REST API
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/state', (req, res) => res.json(getPublicState()));
app.get('/api/matches', (req, res) => res.json(votingMatches));
app.get('/api/ballots/:matchId', (req, res) => {
  const { matchId } = req.params;
  const match = votingMatches.find(m => m.matchId === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.matchType === 'A') res.json({ ballots: typeABallots[matchId] || [], stats: typeAStats[matchId] || {} });
  else res.json({ ballots: typeBBallots[matchId] || [], stats: typeBStats[matchId] || {} });
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'build', 'index.html')));
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => { console.log(`🏟️  Arena server running on port ${PORT}`); });
