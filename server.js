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
const io = new Server(server, { cors: { origin: '*' } });

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

// ════════════════════════════════════════════════════════════════════════════
// STATE ARCHITECTURE: Two clearly separated buckets.
//
//  draftState  — highly volatile, rapidly mutating during picks/turns/resets.
//                Wiped freely by refReset / refStartDraft.
//
//  votingState — persistent voting collection.
//                NEVER touched by any draft operation.
//
// The single gameState object sent to clients is assembled by buildGameState()
// which merges both buckets just before emission, keeping them insulated from
// each other at the server level.
// ════════════════════════════════════════════════════════════════════════════

// Draft bucket — only draft-related, volatile fields live here.
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
  matchLocked: false,
  youtubeLink: 'https://www.youtube.com',
  arenaBanner: '',
  qrCodes: ['', '', '', '', '', ''],
  team1Formation: '4-4-2',
  team2Formation: '4-4-2',
  team1Tactics: {},
  team2Tactics: {},
};

// Voting bucket — persistent, append-only from the outside. Never cleared by draft ops.
let votingState = {
  votingMatches: [],
};

// Merges both buckets into one flat object for socket emission.
function buildGameState() {
  return { ...draftState, ...votingState };
}

// Emit a full merged state to all clients.
function broadcastState() {
  io.emit('gameStateUpdate', buildGameState());
}

// ════════════════════════════════════════════════════════════════════════════
// VOTING ENGINE HELPERS
// ════════════════════════════════════════════════════════════════════════════

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

// FIX: refreshVotingMatches now ONLY updates votingState.votingMatches.
// It never touches draftState, so draft resets cannot wipe vote data, and
// vote refreshes cannot accidentally reset draft fields.
async function refreshVotingMatches() {
  try {
    votingState.votingMatches = await fetchVotingMatches();
    broadcastState();
    console.log(`[Voting] Refreshed – ${votingState.votingMatches.length} matches total`);
  } catch (err) {
    console.error('[Voting] refreshVotingMatches failed:', err.message);
  }
}

// Background poll every 60 seconds – only touches votingState, never draftState.
setInterval(refreshVotingMatches, 60000);

// ── Cloudflare Handshake ──────────────────────────────────────────────────────
async function getSecureStream() {
  if (!CF_CONFIG.token || !CF_CONFIG.accId || !CF_CONFIG.uid) return null;
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_CONFIG.accId}/stream/${CF_CONFIG.uid}/token`;
    const res = await axios.post(url, {}, { headers: { Authorization: `Bearer ${CF_CONFIG.token}`, 'Content-Type': 'application/json' } });
    if (res.data?.result?.token) {
      return `https://customer-v7ps8f9e01.cloudflarestream.com/${res.data.result.token}/iframe`;
    }
    return null;
  } catch (err) {
    console.error('[CF] Handshake failed:', err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SOCKET CONNECTIONS
// ════════════════════════════════════════════════════════════════════════════
io.on('connection', async (socket) => {
  if (votingState.votingMatches.length === 0) {
    await refreshVotingMatches();
  }

  socket.emit('gameStateUpdate', buildGameState());

  // ── CORE DRAFT MECHANICS ──────────────────────────────────────────────────

  socket.on('claimReferee', (token) => {
    if (token === 'eric_ref_2024') {
      draftState.refereeId = socket.id;
      broadcastState();
      socket.emit('refConfirm', true);
    }
  });

  socket.on('joinWaitingRoom', async (data) => {
    const name = data.name?.trim();
    const txId = data.ticketCode?.trim();
    if (!txId || !name) return;

    const alreadyActive = draftState.allViewers.find(v => v.txId === txId && v.id !== socket.id);
    if (alreadyActive) return socket.emit('error', "Iyi code iri gukoreshwa n'undi muntu.");

    try {
      const verificationUrl = `${SENTINEL_URL}?code=${txId}&name=${encodeURIComponent(name)}`;
      const response = await axios.get(verificationUrl, { maxRedirects: 5 });
      if (response.data && response.data.valid) {
        const amount = Number(response.data.amount) || 0;
        let secureLink = amount >= 2000 ? await getSecureStream() : null;
        let userIdx = draftState.allViewers.findIndex(v => v.txId === txId);

        if (userIdx !== -1) {
          draftState.allViewers[userIdx].id = socket.id;
          draftState.allViewers[userIdx].secureLink = secureLink;
          draftState.allViewers[userIdx].isPremium = amount >= 2000;
          if (draftState.team1Player?.txId === txId) draftState.team1Player.id = socket.id;
          if (draftState.team2Player?.txId === txId) draftState.team2Player.id = socket.id;
        } else {
          draftState.allViewers.push({
            id: socket.id,
            name,
            role: 'spectator',
            txId,
            isPremium: amount >= 2000,
            secureLink
          });
        }

        broadcastState();
      } else {
        socket.emit('error', 'Iyi code ntizwi cyangwa ntiyishyuwe.');
      }
    } catch {
      socket.emit('error', 'Sentinel Error');
    }
  });

  socket.on('refUpdateBanner', (url) => {
    if (socket.id !== draftState.refereeId) return;
    draftState.arenaBanner = url;
    broadcastState();
  });

  socket.on('refAssignRole', (data) => {
    if (socket.id !== draftState.refereeId) return;
    const user = draftState.allViewers.find(v => v.id === data.userId);
    if (user) {
      user.role = data.role;
      if (data.role === 'team1') draftState.team1Player = { id: user.id, name: user.name, txId: user.txId };
      if (data.role === 'team2') draftState.team2Player = { id: user.id, name: user.name, txId: user.txId };
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

      broadcastState();
      io.emit('gameSyncPhase', 'DRAFT');
    } catch (err) {
      console.error('[Draft] Start error:', err.message);
      socket.emit('error', 'Draft start failed – could not load player cards. Please retry.');
    }
  });

  socket.on('refReset', () => {
    if (socket.id !== draftState.refereeId) return;

    draftState.gameStarted = false;
    draftState.matchLocked = false;
    draftState.availableCards = [];
    draftState.team1Picks = [];
    draftState.team2Picks = [];
    draftState.team1Tactics = {};
    draftState.team2Tactics = {};
    draftState.team1Player = null;
    draftState.team2Player = null;
    draftState.currentTurn = 'team1';
    draftState.team1Formation = '4-4-2';
    draftState.team2Formation = '4-4-2';
    draftState.allViewers.forEach(v => (v.role = 'spectator'));

    broadcastState();
    io.emit('gameSyncPhase', 'LOBBY');
  });

  socket.on('refClearArena', () => {
    if (socket.id !== draftState.refereeId) return;

    draftState.allViewers = [];
    draftState.gameStarted = false;
    draftState.matchLocked = false;
    draftState.availableCards = [];
    draftState.team1Picks = [];
    draftState.team2Picks = [];
    draftState.team1Tactics = {};
    draftState.team2Tactics = {};
    draftState.team1Player = null;
    draftState.team2Player = null;
    draftState.currentTurn = 'team1';
    draftState.team1Formation = '4-4-2';
    draftState.team2Formation = '4-4-2';
    draftState.qrCodes = ['', '', '', '', '', ''];
    draftState.youtubeLink = 'https://www.youtube.com';
    draftState.arenaBanner = '';

    io.emit('clearArenaForce');
    broadcastState();
  });

  socket.on('refUpdateYoutube', (link) => {
    if (socket.id !== draftState.refereeId) return;
    draftState.youtubeLink = link;
    broadcastState();
  });

  socket.on('refUpdateQRs', (qrs) => {
    if (socket.id !== draftState.refereeId) return;
    draftState.qrCodes = qrs;
    broadcastState();
  });

  socket.on('refLockMatch', () => {
    if (socket.id !== draftState.refereeId) return;
    draftState.matchLocked = true;
    broadcastState();
  });

  socket.on('playerPickCard', (cardId) => {
    const user = draftState.allViewers.find(v => v.id === socket.id);
    if (!user || user.role !== draftState.currentTurn) return;

    const card = draftState.availableCards.find(c => c.id === cardId);
    if (!card) return;

    const myTeam = user.role === 'team1' ? draftState.team1Picks : draftState.team2Picks;
    if (myTeam.length >= 11) return;

    myTeam.push(card);
    draftState.availableCards = draftState.availableCards.filter(c => c.id !== cardId);

    const otherTeam = user.role === 'team1' ? 'team2' : 'team1';
    const otherPicks = user.role === 'team1' ? draftState.team2Picks : draftState.team1Picks;

    if (draftState.team1Picks.length >= 11 && draftState.team2Picks.length >= 11) {
      draftState.currentTurn = 'FINISHED';
    } else {
      draftState.currentTurn = otherPicks.length < 11 ? otherTeam : user.role;
    }

    broadcastState();
  });

  socket.on('playerSetPosition', (data) => {
    if (draftState.matchLocked) return;

    const user = draftState.allViewers.find(v => v.id === socket.id);
    if (!user || !user.role.startsWith('team')) return;

    const tactics = draftState[`${user.role}Tactics`];
    const picks = draftState[`${user.role}Picks`];
    const card = picks.find(p => p.id === data.cardId);

    if (card) {
      Object.keys(tactics).forEach(k => {
        if (tactics[k].id === data.cardId) delete tactics[k];
      });
      tactics[data.slotIndex] = card;
      broadcastState();
    }
  });

  socket.on('playerSetFormation', (formation) => {
    if (draftState.matchLocked) return;

    const user = draftState.allViewers.find(v => v.id === socket.id);
    if (!user || !user.role.startsWith('team')) return;

    draftState[`${user.role}Formation`] = formation;
    draftState[`${user.role}Tactics`] = {};
    broadcastState();
  });

  // ── VOTING ENGINE SOCKET LISTENERS ───────────────────────────────────────

  socket.on('refSaveLiveSession', async () => {
    if (socket.id !== draftState.refereeId) return;

    if (!draftState.matchLocked) {
      return socket.emit('refSaveLiveSession_ack', {
        success: false,
        error: 'Match must be locked before saving.'
      });
    }

    const coach1 = draftState.team1Player?.name || 'Coach 1';
    const coach2 = draftState.team2Player?.name || 'Coach 2';
    const matchId = Date.now();

    const payload = {
      action: 'saveLiveMatch',
      matchId,
      name: `Live Session – ${coach1} vs ${coach2}`,
      coach1,
      coach2,
      t1Tactics: JSON.stringify(draftState.team1Tactics),
      t2Tactics: JSON.stringify(draftState.team2Tactics),
    };

    try {
      await axios.post(VOTING_BRIDGE_URL, payload, {
        headers: { 'Content-Type': 'application/json' },
        maxRedirects: 5,
        timeout: 10000
      });

      await refreshVotingMatches();
      socket.emit('refSaveLiveSession_ack', { success: true, matchId });
    } catch (err) {
      console.error('[Voting] saveLiveMatch error:', err.message);
      socket.emit('refSaveLiveSession_ack', {
        success: false,
        error: err.message
      });
    }
  });

  socket.on('refToggleVotingStatus', async ({ matchId, matchType, newStatus }) => {
    if (socket.id !== draftState.refereeId) return;

    const idx = votingState.votingMatches.findIndex(
      m => String(m.matchId) === String(matchId)
    );

    if (idx !== -1) {
      votingState.votingMatches[idx].status = newStatus;
      broadcastState();
    }

    try {
      await axios.post(
        VOTING_BRIDGE_URL,
        { action: 'toggleVotingStatus', matchId, matchType, newStatus },
        {
          headers: { 'Content-Type': 'application/json' },
          maxRedirects: 5,
          timeout: 10000
        }
      );
    } catch (err) {
      console.error('[Voting] toggleVotingStatus sync error:', err.message);
    }
  });

  socket.on('refGetBallots', async ({ matchId }) => {
    if (socket.id !== draftState.refereeId) return;

    try {
      const res = await axios.get(
        `${VOTING_BRIDGE_URL}?action=getBallots&matchId=${encodeURIComponent(matchId)}`,
        { maxRedirects: 5, timeout: 12000 }
      );

      const ballots = Array.isArray(res.data)
        ? res.data
        : Array.isArray(res.data?.ballots)
          ? res.data.ballots
          : [];

      socket.emit('refBallotData', { matchId, ballots });
    } catch (err) {
      console.error('[Voting] getBallots error:', err.message);
      socket.emit('refBallotData', { matchId, ballots: [], error: err.message });
    }
  });

  socket.on('refRefreshVotingMatches', async () => {
    if (socket.id !== draftState.refereeId) return;
    await refreshVotingMatches();
  });

  socket.on('fanSubmitBallot', async ({ txId, matchId, coachVote, scores }) => {
    const viewer = draftState.allViewers.find(
      v => v.id === socket.id && v.txId === txId
    );

    if (!viewer) {
      return socket.emit('ballotResult', { error: 'NOT_VERIFIED' });
    }

    const match = votingState.votingMatches.find(
      m => String(m.matchId) === String(matchId)
    );

    if (!match || match.status !== 'OPEN') {
      return socket.emit('ballotResult', { error: 'MATCH_CLOSED' });
    }

    try {
      const res = await axios.post(
        VOTING_BRIDGE_URL,
        { action: 'submitBallot', txId, matchId, coachVote, scores },
        {
          headers: { 'Content-Type': 'application/json' },
          maxRedirects: 5,
          timeout: 12000
        }
      );

      const data = res.data;
      const alreadyVoted =
        data === 'ALREADY_VOTED' ||
        data?.error === 'ALREADY_VOTED' ||
        data?.result === 'ALREADY_VOTED';

      if (alreadyVoted) {
        return socket.emit('ballotResult', { error: 'ALREADY_VOTED' });
      }

      socket.emit('ballotResult', { success: true });
    } catch (err) {
      console.error('[Voting] submitBallot network error:', err.message);
      socket.emit('ballotResult', { error: 'SERVER_ERROR' });
    }
  });
});

app.get('/health', (_req, res) => res.status(200).send('Arena Engine is Awake'));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Arena Backend Masterpiece Online — port ${PORT}`);
  refreshVotingMatches();
});
