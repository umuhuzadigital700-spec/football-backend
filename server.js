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

// ── Config ────────────────────────────────────────────────────────────────────
const REF_TOKEN = process.env.REF_TOKEN || 'REFEREE_2025';
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || '';

// ── Player cards ──────────────────────────────────────────────────────────────
let masterCardPool = [];
try {
  masterCardPool = require('./cards.json');
  console.log('[cards] Loaded', masterCardPool.length, 'cards from cards.json');
} catch (e) {
  const positions = ['GK','CB','CB','LB','RB','CM','CM','DM','LW','RW','ST'];
  const firstNames = ['Jean','Pierre','David','Eric','Patrick','Kevin','James','Paul','Mark','Lucas','Omar','Sami','Ali','Yves','Frank','Ivan','Moses','Aaron','Isaac','Daniel','Michael','Robert','Chris','Tony','Steve'];
  const lastNames = ['Mugabo','Nkurunziza','Habimana','Uwimana','Ndayishimiye','Bizimana','Hakizimana','Niyonzima','Tuyizere','Uwase','Kayitesi','Munyaneza','Nsengimana','Hategekimana','Kamanzi','Ndagijimana','Uwera','Gatera','Nzeyimana','Ishimwe'];
  masterCardPool = Array.from({ length: 60 }, (_, i) => ({
    id: 'P' + (i + 1),
    name: firstNames[i % firstNames.length] + ' ' + lastNames[i % lastNames.length],
    position: positions[i % positions.length],
    rating: 65 + Math.floor((i * 7 + 13) % 30),
    nationality: 'RW',
  }));
  console.log('[cards] Using 60 built-in dummy cards');
}

// ── Match ID ──────────────────────────────────────────────────────────────────
let liveMatchCounter = 0;
function nextMatchId() {
  liveMatchCounter++;
  const ts = new Date().toISOString().replace(/[-:T]/g,'').substring(0,12);
  return 'MATCH-' + String(liveMatchCounter).padStart(3,'0') + '-' + ts;
}

// ── Persistent data (survives resets) ─────────────────────────────────────────
let savedSessions = [];
let votingMatches = [];
let voteRegistry = {};
let typeAStats = {};
let typeBStats = {};
let typeABallots = {};
let typeBBallots = {};

// ── Volatile state ────────────────────────────────────────────────────────────
function freshState() {
  return {
    allViewers: [],
    gameStarted: false,
    roomPhase: 'LOBBY',
    votingAllowed: false,
    votingMode: 'BOTH',
    arenaBanner: null,
    youtubeLink: null,
    qrCodes: ['','','','','',''],
    welcomeMessage: '',
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
let S = freshState();

function pub() {
  return { ...S, savedSessions, votingMatches, voteRegistry, typeAStats, typeBStats };
}
function broadcast() { io.emit('gameStateUpdate', pub()); }
function bySocket(id) { return S.allViewers.find(v => v.id === id); }
function byTxId(txId) { return S.allViewers.find(v => v.txId === txId); }

function recalcA(matchId) {
  const b = typeABallots[matchId] || [];
  let t1=0,t2=0;
  b.forEach(x => { if(x.teamVote==='team1') t1++; else if(x.teamVote==='team2') t2++; });
  typeAStats[matchId] = { team1Votes:t1, team2Votes:t2 };
}
function recalcB(matchId) {
  const b = typeBBallots[matchId] || [];
  if(!b.length){ typeBStats[matchId]={}; return; }
  const tot={},cnt={};
  b.forEach(x => Object.entries(x.scores||{}).forEach(([n,v])=>{ tot[n]=(tot[n]||0)+v; cnt[n]=(cnt[n]||0)+1; }));
  typeBStats[matchId]={};
  Object.keys(tot).forEach(n=>{ typeBStats[matchId][n]=(tot[n]/cnt[n]).toFixed(1); });
}

// ── Payment verification ──────────────────────────────────────────────────────
async function verifyPayment(txId, name) {
  if (!APPS_SCRIPT_URL) {
    console.log('[verify] No APPS_SCRIPT_URL — open access mode');
    return { success: true, isPremium: false };
  }
  try {
    const url = APPS_SCRIPT_URL + '?action=verify&txId=' + encodeURIComponent(txId) + '&name=' + encodeURIComponent(name);
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return { success: !!d.success, isPremium: !!d.isPremium, error: d.error || 'Payment not found' };
  } catch(e) {
    console.error('[verify] Error:', e.message);
    return { success: false, error: 'Verification unavailable. Try again.' };
  }
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[+]', socket.id);
  socket.emit('gameStateUpdate', pub());

  // FAN JOIN
  socket.on('joinWaitingRoom', async ({ name, ticketCode } = {}) => {
    const n = String(name||'').trim();
    const txId = String(ticketCode||'').trim();
    if (!n || !txId) { socket.emit('joinResult', { success:false, error:'Name and Transaction ID are required.' }); return; }

    // Reconnect
    const existing = byTxId(txId);
    if (existing) {
      existing.id = socket.id;
      socket.emit('joinResult', { success:true, isPremium: existing.isPremium });
      socket.emit('gameStateUpdate', pub());
      return;
    }

    const result = await verifyPayment(txId, n);
    if (!result.success) {
      socket.emit('joinResult', { success:false, error: result.error });
      return;
    }

    const viewer = { id:socket.id, txId, name:n, role:'spectator', isPremium:!!result.isPremium };
    S.allViewers.push(viewer);
    socket.emit('joinResult', { success:true, isPremium: viewer.isPremium });
    broadcast();
  });

  // REFEREE
  socket.on('claimReferee', token => {
    if (token !== REF_TOKEN) { socket.emit('refConfirm', false); return; }
    socket.emit('refConfirm', true);
    socket.emit('gameStateUpdate', pub());
  });

  socket.on('refSetBanner', url => { S.arenaBanner = url||null; broadcast(); });
  socket.on('refSetYoutube', url => { S.youtubeLink = url||null; broadcast(); });
  socket.on('refSetQRCodes', qrs => { if(Array.isArray(qrs)) S.qrCodes=qrs; broadcast(); });
  socket.on('refSetWelcome', msg => { S.welcomeMessage = String(msg||''); broadcast(); });

  socket.on('refAssignRole', ({ userId, role }) => {
    const v = S.allViewers.find(x => x.id===userId);
    if (!v) return;
    v.role = role;
    if (role==='team1') S.team1Player=v;
    else if (role==='team2') S.team2Player=v;
    broadcast();
  });

  socket.on('refRemoveViewer', ({ userId }) => {
    S.allViewers = S.allViewers.filter(v => v.id !== userId);
    if (S.team1Player && S.team1Player.id===userId) S.team1Player=null;
    if (S.team2Player && S.team2Player.id===userId) S.team2Player=null;
    broadcast();
  });

  socket.on('refStartDraft', () => {
    S.gameStarted=true; S.roomPhase='DRAFT';
    S.matchLocked=false; S.matchReady=false;
    S.team1Picks=[]; S.team2Picks=[];
    S.team1Tactics={}; S.team2Tactics={};
    S.currentTurn='team1';
    S.availableCards=[...masterCardPool].sort(()=>Math.random()-0.5);
    io.emit('gameSyncPhase','DRAFT');
    broadcast();
  });

  socket.on('refLockMatch', () => { S.matchLocked=true; broadcast(); });

  socket.on('refMatchReady', () => {
    S.matchReady=true; S.matchLocked=true;
    socket.emit('refMatchReady_ack', { success:true });
    broadcast();
  });

  socket.on('refSaveLiveSession', () => {
    if (!S.matchReady) { socket.emit('refSaveLiveSession_ack',{success:false,error:'Mark match Ready first.'}); return; }
    const c1 = S.team1Player?.name||'Team 1';
    const c2 = S.team2Player?.name||'Team 2';
    const matchId = nextMatchId();
    const entry = {
      matchId, matchType:'A', status:'OPEN',
      name: c1+' vs '+c2,
      coach1:c1, coach2:c2,
      team1Picks: JSON.parse(JSON.stringify(S.team1Picks)),
      team2Picks: JSON.parse(JSON.stringify(S.team2Picks)),
      team1Formation: S.team1Formation, team2Formation: S.team2Formation,
      t1Tactics: JSON.parse(JSON.stringify(S.team1Tactics)),
      t2Tactics: JSON.parse(JSON.stringify(S.team2Tactics)),
      savedAt: new Date().toISOString(),
    };
    savedSessions.push(entry);
    votingMatches.push(entry);
    typeABallots[matchId]=[]; typeAStats[matchId]={team1Votes:0,team2Votes:0};
    voteRegistry[matchId]=[];
    socket.emit('refSaveLiveSession_ack',{success:true,matchId});
    broadcast();
  });

  socket.on('refToggleVotingGate', ({ allowed, mode }) => {
    S.votingAllowed=!!allowed; S.votingMode=mode||'BOTH';
    if(allowed) io.emit('gameSyncPhase','VOTING');
    broadcast();
  });

  socket.on('refToggleVotingStatus', ({ matchId, newStatus }) => {
    [votingMatches,savedSessions].forEach(arr=>{ const m=arr.find(x=>x.matchId===matchId); if(m) m.status=newStatus; });
    broadcast();
  });

  socket.on('refLoadTypeBMatches', matches => {
    if(!Array.isArray(matches)) return;
    matches.forEach(m => {
      const matchId = m.matchId||m.tabName||m.name;
      if(!matchId||votingMatches.find(x=>x.matchId===matchId)) return;
      votingMatches.push({...m,matchId,matchType:'B',status:m.status||'CLOSED'});
      typeBBallots[matchId]=[]; typeBStats[matchId]={}; voteRegistry[matchId]=[];
    });
    broadcast();
  });

  socket.on('refGetBallots', ({ matchId }) => {
    const m = votingMatches.find(x=>x.matchId===matchId);
    if(!m){ socket.emit('refBallotData',{matchId,ballots:[]}); return; }
    if(m.matchType==='A') socket.emit('refBallotData',{matchId,ballots:(typeABallots[matchId]||[]).map(b=>({txId:b.txId,teamVote:b.teamVote}))});
    else socket.emit('refBallotData',{matchId,ballots:(typeBBallots[matchId]||[]).map(b=>({txId:b.txId,scores:b.scores}))});
  });

  socket.on('refReset', () => {
    S.team1Player=null; S.team2Player=null;
    S.team1Picks=[]; S.team2Picks=[];
    S.team1Tactics={}; S.team2Tactics={};
    S.team1Formation='4-4-2'; S.team2Formation='4-4-2';
    S.currentTurn='team1'; S.gameStarted=false; S.roomPhase='LOBBY';
    S.matchLocked=false; S.matchReady=false; S.availableCards=[];
    S.allViewers.forEach(v=>{ v.role='spectator'; });
    io.emit('gameSyncPhase','LOBBY');
    broadcast();
  });

  socket.on('refRestart', () => {
    S.team1Picks=[]; S.team2Picks=[];
    S.team1Tactics={}; S.team2Tactics={};
    S.currentTurn='team1'; S.matchLocked=false; S.matchReady=false;
    S.availableCards=[...masterCardPool].sort(()=>Math.random()-0.5);
    io.emit('gameSyncPhase','DRAFT');
    broadcast();
  });

  socket.on('refClearArena', () => {
    savedSessions=[]; votingMatches=[]; voteRegistry={};
    typeAStats={}; typeBStats={}; typeABallots={}; typeBBallots={};
    liveMatchCounter=0; S=freshState();
    io.emit('clearArenaForce');
    broadcast();
  });

  // PLAYER ACTIONS
  socket.on('playerPickCard', cardId => {
    if(!S.gameStarted||S.matchReady) return;
    const v=bySocket(socket.id);
    if(!v||!['team1','team2'].includes(v.role)) return;
    if(S.currentTurn!==v.role) { socket.emit('error','Not your turn.'); return; }
    const picks = v.role==='team1'?S.team1Picks:S.team2Picks;
    if(picks.length>=11) { socket.emit('error','Roster full.'); return; }
    const strId=String(cardId);
    if([...S.team1Picks,...S.team2Picks].some(c=>String(c.id)===strId)) { socket.emit('error','Already picked.'); return; }
    const idx=S.availableCards.findIndex(c=>String(c.id)===strId);
    if(idx===-1) { socket.emit('error','Card not available.'); return; }
    const [card]=S.availableCards.splice(idx,1);
    picks.push(card);
    S.currentTurn=v.role==='team1'?'team2':'team1';
    broadcast();
  });

  socket.on('playerSetFormation', ({ team, formation }) => {
    if(S.matchReady) return;
    const v=bySocket(socket.id);
    if(!v||v.role!==team) return;
    if(team==='team1') S.team1Formation=formation; else S.team2Formation=formation;
    broadcast();
  });

  socket.on('playerSetPosition', ({ cardId, slotIndex }) => {
    if(S.matchReady) return;
    const v=bySocket(socket.id);
    if(!v||!['team1','team2'].includes(v.role)) return;
    const picks=v.role==='team1'?S.team1Picks:S.team2Picks;
    const tactics=v.role==='team1'?S.team1Tactics:S.team2Tactics;
    const strId=String(cardId);
    if(!picks.some(c=>String(c.id)===strId)) { socket.emit('error','Not your card.'); return; }
    Object.keys(tactics).forEach(s=>{ if(tactics[s]&&String(tactics[s].id)===strId) delete tactics[s]; });
    if(tactics[slotIndex]) delete tactics[slotIndex];
    tactics[slotIndex]=picks.find(c=>String(c.id)===strId);
    broadcast();
  });

  // VOTING
  socket.on('fanSubmitBallot', ({ txId, matchId, teamVote, scores, matchType }) => {
    if(!S.votingAllowed) { socket.emit('ballotResult',{success:false,error:'Voting is closed.'}); return; }
    const m=votingMatches.find(x=>x.matchId===matchId);
    if(!m||m.status!=='OPEN') { socket.emit('ballotResult',{success:false,error:'This match is not open for voting.'}); return; }
    if(!byTxId(txId)) { socket.emit('ballotResult',{success:false,error:'You must be verified to vote.'}); return; }
    if(!voteRegistry[matchId]) voteRegistry[matchId]=[];
    if(voteRegistry[matchId].includes(txId)) { socket.emit('ballotResult',{success:false,error:'You already voted on this match.'}); return; }
    voteRegistry[matchId].push(txId);
    if(m.matchType==='A') {
      if(!typeABallots[matchId]) typeABallots[matchId]=[];
      typeABallots[matchId].push({txId,teamVote,timestamp:Date.now()});
      recalcA(matchId);
    } else {
      if(!typeBBallots[matchId]) typeBBallots[matchId]=[];
      typeBBallots[matchId].push({txId,scores:scores||{},timestamp:Date.now()});
      recalcB(matchId);
    }
    socket.emit('ballotResult',{success:true});
    broadcast();
  });
});

app.get('/api/state', (_,res) => res.json(pub()));
app.get('/api/matches', (_,res) => res.json(votingMatches));
app.get('/api/ballots/:matchId', (req,res) => {
  const m=votingMatches.find(x=>x.matchId===req.params.matchId);
  if(!m) return res.status(404).json({error:'Not found'});
  res.json(m.matchType==='A'
    ? {ballots:typeABallots[req.params.matchId]||[],stats:typeAStats[req.params.matchId]||{}}
    : {ballots:typeBBallots[req.params.matchId]||[],stats:typeBStats[req.params.matchId]||{}});
});

const PORT=process.env.PORT||4000;
server.listen(PORT,()=>console.log('Arena server on port',PORT));
