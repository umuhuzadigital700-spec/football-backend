const express = require('express');
const http = require('http');
// REMOVED: const { Server } = require('socket.io'); -> Vercel doesn't support persistent WebSockets.
const cors = require('cors');
const axios = require('axios');
const csv = require('csvtojson');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

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
// ════════════════════════════════════════════════════════════════════════════

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

let votingState = {
  votingMatches: [],
};

function buildGameState() {
  return { ...draftState, ...votingState };
}

// Emits state mock for architectural logic preservation
function broadcastState() {
  // Logic order preservation placeholder
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

async function refreshVotingMatches() {
  try {
    votingState.votingMatches = await fetchVotingMatches();
    broadcastState();
    console.log(`[Voting] Refreshed – ${votingState.votingMatches.length} matches total`);
  } catch (err) {
    console.error('[Voting] refreshVotingMatches failed:', err.message);
  }
}

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
// VERCEL SERVERLESS COMPATIBLE HTTP ROUTER MAPPING FOR SOCKET EVENTS
// ════════════════════════════════════════════════════════════════════════════

// Emulates socket tracking using HTTP context bodies
app.post('/api/socket-emulation', async (req, res) => {
  const { event, data, socketId, token, txId, matchId, coachVote, scores, matchType, newStatus, cardId, slotIndex, formation, link, qrs } = req.body;
  
  // Setup standard fallback response payload shell
  let responsePayload = { emit: [], broadcast: null };
  const fallbackSocket = {
    id: socketId || 'system-fallback-id',
    emit: (ev, payload) => responsePayload.emit.push({ event: ev, data: payload })
  };

  if (votingState.votingMatches.length === 0) {
    await refreshVotingMatches();
  }

  // --- Exact Logic Match Execution block ---
  switch(event) {
    case 'claimReferee':
      if (token === 'eric_ref_2024') {
        draftState.refereeId = fallbackSocket.id;
        responsePayload.broadcast = buildGameState();
        fallbackSocket.emit('refConfirm', true);
      }
      break;

    case 'joinWaitingRoom':
      const name = data?.name?.trim();
      const ticketCode = data?.ticketCode?.trim();
      if (!ticketCode || !name) break;

      const alreadyActive = draftState.allViewers.find(v => v.txId === ticketCode && v.id !== fallbackSocket.id);
      if (alreadyActive) {
        fallbackSocket.emit('error', "Iyi code iri gukoreshwa n'undi muntu.");
        break;
      }

      try {
        const verificationUrl = `${SENTINEL_URL}?code=${ticketCode}&name=${encodeURIComponent(name)}`;
        const response = await axios.get(verificationUrl, { maxRedirects: 5 });
        if (response.data && response.data.valid) {
          const amount = Number(response.data.amount) || 0;
          let secureLink = amount >= 2000 ? await getSecureStream() : null;
          let userIdx = draftState.allViewers.findIndex(v => v.txId === ticketCode);

          if (userIdx !== -1) {
            draftState.allViewers[userIdx].id = fallbackSocket.id;
            draftState.allViewers[userIdx].secureLink = secureLink;
            draftState.allViewers[userIdx].isPremium = amount >= 2000;
            if (draftState.team1Player?.txId === ticketCode) draftState.team1Player.id = fallbackSocket.id;
            if (draftState.team2Player?.txId === ticketCode) draftState.team2Player.id = fallbackSocket.id;
          } else {
            draftState.allViewers.push({
              id: fallbackSocket.id,
              name,
              role: 'spectator',
              txId: ticketCode,
              isPremium: amount >= 2000,
              secureLink
            });
          }
          responsePayload.broadcast = buildGameState();
        } else {
          fallbackSocket.emit('error', 'Iyi code ntizwi cyangwa ntiyishyuwe.');
        }
      } catch {
        fallbackSocket.emit('error', 'Sentinel Error');
      }
      break;

    case 'refUpdateBanner':
      if (fallbackSocket.id !== draftState.refereeId) break;
      draftState.arenaBanner = url;
      responsePayload.broadcast = buildGameState();
      break;

    case 'refAssignRole':
      if (fallbackSocket.id !== draftState.refereeId) break;
      const user = draftState.allViewers.find(v => v.id === data.userId);
      if (user) {
        user.role = data.role;
        if (data.role === 'team1') draftState.team1Player = { id: user.id, name: user.name, txId: user.txId };
        if (data.role === 'team2') draftState.team2Player = { id: user.id, name: user.name, txId: user.txId };
        responsePayload.broadcast = buildGameState();
      }
      break;

    case 'refStartDraft':
      if (fallbackSocket.id !== draftState.refereeId) break;
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

        responsePayload.broadcast = buildGameState();
        responsePayload.phaseSync = 'DRAFT';
      } catch (err) {
        console.error('[Draft] Start error:', err.message);
        fallbackSocket.emit('
