// Wizard - Online-Server
// Einfacher, selbst-gehosteter Mehrspieler-Server auf Basis von Express + Socket.IO.
// Kann lokal, im Heimnetz oder z.B. auf einem Raspberry Pi laufen.
// Regelwerk: offizielle AMIGO-Spielanleitung "Wizard" (Grundspiel, ohne Varianten).

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Spielregeln / Konstanten (siehe Regelwerk "Wizard")
// ---------------------------------------------------------------------------

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const MAX_ROOMS = 500; // Sicherheitsventil gegen Speicher-Erschöpfung durch Missbrauch
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne verwechselbare Zeichen

// Die vier Charakterfarben aus der Anleitung.
const SUITS = ['blau', 'gruen', 'rot', 'gelb'];
const SUIT_INFO = {
  blau: { name: 'Menschen', icon: '🔷', color: '#3b82f6' },
  gruen: { name: 'Elfen', icon: '🍀', color: '#22c55e' },
  rot: { name: 'Zwerge', icon: '🔺', color: '#ef4444' },
  gelb: { name: 'Riesen', icon: '⭐', color: '#eab308' },
};

function buildDeck() {
  const deck = [];
  SUITS.forEach((suit) => {
    for (let value = 1; value <= 13; value++) {
      deck.push({ id: `${suit}${value}`, kind: 'suit', suit, value });
    }
  });
  for (let i = 1; i <= 4; i++) deck.push({ id: `z${i}`, kind: 'wizard' });
  for (let i = 1; i <= 4; i++) deck.push({ id: `n${i}`, kind: 'jester' });
  return deck; // 60 Karten
}

function maxRoundsFor(playerCount) {
  return Math.floor(60 / playerCount);
}

const BOT_NAME_POOL = [
  'Bot Merlin', 'Bot Morgana', 'Bot Gandalf', 'Bot Circe',
  'Bot Radagast', 'Bot Zatanna', 'Bot Alatriste', 'Bot Elminster',
];

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Einfaches Rate-Limiting (Schutz vor Missbrauch, da öffentlich erreichbar)
// ---------------------------------------------------------------------------

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

const rateLimitHits = new Map(); // key -> Array<timestamp>

function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateLimitHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    rateLimitHits.set(key, hits);
    return true;
  }
  hits.push(now);
  rateLimitHits.set(key, hits);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitHits) {
    const fresh = hits.filter((t) => now - t < 10 * 60 * 1000);
    if (fresh.length) rateLimitHits.set(key, fresh);
    else rateLimitHits.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Raumverwaltung
// ---------------------------------------------------------------------------

const rooms = new Map(); // code -> room
const ROOM_CLEANUP_MS = 3 * 60 * 60 * 1000; // Räume ohne Aktivität nach 3h entsorgen

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: null,
    players: [], // { id, token, name, socketId, connected, isBot }
    phase: 'lobby', // lobby | trumpchoice | bidding | playing | trickresult | roundend | gameover
    dealerIndex: 0,
    roundNumber: 0, // 1..maxRounds
    maxRounds: 0,
    cardsThisRound: 0,
    hands: {}, // playerId -> [card, ...]
    trumpCard: null,
    trumpSuit: null, // null = kein Trumpf in dieser Runde
    trumpChoiceById: null,
    bidQueue: [], // playerIds in Vorhersage-Reihenfolge
    bidPointer: 0,
    bids: {}, // playerId -> number
    tricksWon: {}, // playerId -> number
    currentTrick: [], // { playerId, card }
    trickResult: null, // { cards, winnerId } - transient
    trickNumber: 0,
    turnOrder: [], // wird bei Rundenstart aus players.length abgeleitet (Indizes)
    currentTurnIndex: 0,
    scores: {}, // playerId -> number
    history: [], // [{ round, entries: { playerId: {bid, tricks, points, total} } }]
    roundReady: new Set(),
    roundEndTimer: null,
    roundEndDeadline: null, // Epoch-ms, bis wann automatisch weitergegangen wird (oder null)
    trickTimer: null,
    winnerIds: null,
    logs: [],
    lastActivity: Date.now(),
    cleanupTimer: null,
  };
  rooms.set(code, room);
  touchRoom(room);
  return room;
}

function touchRoom(room) {
  room.lastActivity = Date.now();
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    rooms.delete(room.code);
  }, ROOM_CLEANUP_MS);
}

function log(room, text) {
  room.logs.push({ text, at: Date.now() });
  if (room.logs.length > 200) room.logs.shift();
}

function findPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId);
}

function publicPlayer(room, p) {
  return {
    id: p.id,
    name: p.name,
    connected: p.connected,
    isHost: p.id === room.hostId,
    isBot: p.isBot === true,
    handCount: room.hands[p.id] ? room.hands[p.id].length : 0,
  };
}

function dealer(room) {
  if (!room.players.length) return null;
  return room.players[room.dealerIndex % room.players.length];
}

function currentBidder(room) {
  if (room.phase !== 'bidding') return null;
  const id = room.bidQueue[room.bidPointer];
  return id ? findPlayer(room, id) : null;
}

function currentTurnPlayer(room) {
  if (room.phase !== 'playing') return null;
  return room.players[room.currentTurnIndex % room.players.length];
}

// ---------------------------------------------------------------------------
// Stich-Logik (Kern der Wizard-Regeln)
// ---------------------------------------------------------------------------

// Ermittelt die Farbe, die in einem laufenden Stich bedient werden muss.
// undefined = noch offen (bisher nur Narren gespielt), null = für immer offen
// (ein Zauberer wurde gespielt, bevor eine Farbe feststand).
function ledSuitOfTrick(trick) {
  for (const play of trick) {
    if (play.card.kind === 'suit') return play.card.suit;
    if (play.card.kind === 'wizard') return null;
    // Narr: weiter zur nächsten Karte
  }
  return undefined;
}

function legalCardsFor(room, playerId) {
  const hand = room.hands[playerId] || [];
  if (room.phase !== 'playing') return [];
  const led = ledSuitOfTrick(room.currentTrick);
  if (led === null || led === undefined) return hand.slice();
  const hasLed = hand.some((c) => c.kind === 'suit' && c.suit === led);
  if (!hasLed) return hand.slice();
  return hand.filter((c) => (c.kind === 'suit' && c.suit === led) || c.kind === 'wizard' || c.kind === 'jester');
}

// Bestimmt den Gewinner eines abgeschlossenen Stichs.
function resolveTrick(trick, trumpSuit) {
  const firstWizard = trick.find((p) => p.card.kind === 'wizard');
  if (firstWizard) return firstWizard.playerId;

  if (trick.every((p) => p.card.kind === 'jester')) return trick[0].playerId;

  if (trumpSuit) {
    const trumps = trick.filter((p) => p.card.kind === 'suit' && p.card.suit === trumpSuit);
    if (trumps.length) {
      return trumps.reduce((best, cur) => (cur.card.value > best.card.value ? cur : best)).playerId;
    }
  }

  const led = ledSuitOfTrick(trick); // kein Zauberer im Stich (s.o.), also eine echte Farbe
  const ledCards = trick.filter((p) => p.card.kind === 'suit' && p.card.suit === led);
  return ledCards.reduce((best, cur) => (cur.card.value > best.card.value ? cur : best)).playerId;
}

// ---------------------------------------------------------------------------
// Öffentlicher Zustand
// ---------------------------------------------------------------------------

function publicState(room) {
  const d = dealer(room);
  const bidder = currentBidder(room);
  const turnPlayer = currentTurnPlayer(room);
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map((p) => publicPlayer(room, p)),
    hostId: room.hostId,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    suits: SUIT_INFO,
    roundNumber: room.roundNumber,
    maxRounds: room.maxRounds,
    cardsThisRound: room.cardsThisRound,
    dealerId: d ? d.id : null,
    trumpCard: room.trumpCard,
    trumpSuit: room.trumpSuit,
    trumpChoiceById: room.trumpChoiceById,
    bidOrder: room.bidQueue,
    currentBidderId: bidder ? bidder.id : null,
    bids: room.bids,
    tricksWon: room.tricksWon,
    currentTrick: room.currentTrick,
    trickResult: room.trickResult,
    trickNumber: room.trickNumber,
    currentTurnId: turnPlayer ? turnPlayer.id : null,
    scores: room.scores,
    history: room.history,
    roundReady: Array.from(room.roundReady),
    roundEndDeadline: room.roundEndDeadline,
    winnerIds: room.winnerIds,
    logs: room.logs.slice(-30),
  };
}

function sendHandTo(room, player) {
  if (!player.socketId) return;
  const hand = room.hands[player.id] || [];
  const legal = room.phase === 'playing' && currentTurnPlayer(room) && currentTurnPlayer(room).id === player.id
    ? legalCardsFor(room, player.id).map((c) => c.id)
    : null;
  io.to(player.socketId).emit('yourHand', { hand, legalCardIds: legal });
}

function broadcastState(room) {
  io.to(room.code).emit('gameState', publicState(room));
  room.players.forEach((p) => sendHandTo(room, p));
  scheduleBotTurnIfNeeded(room);
}

// ---------------------------------------------------------------------------
// Rundenablauf
// ---------------------------------------------------------------------------

function startGame(room) {
  const n = room.players.length;
  // Zufällige Sitzreihenfolge für diese Partie - unabhängig davon, in welcher
  // Reihenfolge die Spieler dem Raum beigetreten sind. hostId/Sockets sind
  // über die id verknüpft, nicht über die Array-Position, daher unbedenklich.
  room.players = shuffle(room.players);
  room.maxRounds = maxRoundsFor(n);
  room.roundNumber = 0;
  room.dealerIndex = Math.floor(Math.random() * n);
  room.scores = {};
  room.history = [];
  room.winnerIds = null;
  room.logs = [];
  room.players.forEach((p) => { room.scores[p.id] = 0; });
  log(room, 'Das Spiel beginnt.');
  startRound(room);
}

function startRound(room) {
  const n = room.players.length;
  room.roundNumber += 1;
  room.cardsThisRound = room.roundNumber;

  const deck = shuffle(buildDeck());
  room.hands = {};
  const order = [];
  for (let i = 0; i < n; i++) order.push((room.dealerIndex + 1 + i) % n);
  order.forEach((idx) => {
    const p = room.players[idx];
    room.hands[p.id] = deck.splice(0, room.cardsThisRound);
  });

  room.bids = {};
  room.tricksWon = {};
  room.players.forEach((p) => {
    room.bids[p.id] = null;
    room.tricksWon[p.id] = 0;
  });
  room.currentTrick = [];
  room.trickResult = null;
  room.trickNumber = 1;
  room.roundReady = new Set();

  if (deck.length > 0) {
    room.trumpCard = deck[0];
  } else {
    room.trumpCard = null; // letzte Runde: keine Karte übrig
  }

  if (!room.trumpCard) {
    room.trumpSuit = null;
    room.trumpChoiceById = null;
    beginBidding(room);
  } else if (room.trumpCard.kind === 'jester') {
    room.trumpSuit = null;
    room.trumpChoiceById = null;
    beginBidding(room);
  } else if (room.trumpCard.kind === 'wizard') {
    room.trumpSuit = null;
    room.trumpChoiceById = dealer(room).id;
    room.phase = 'trumpchoice';
    log(room, `Trumpfkarte ist ein Zauberer - ${dealer(room).name} bestimmt die Trumpffarbe.`);
  } else {
    room.trumpSuit = room.trumpCard.suit;
    room.trumpChoiceById = null;
    beginBidding(room);
  }

  log(room, `Runde ${room.roundNumber}/${room.maxRounds} beginnt (${room.cardsThisRound} Karte${room.cardsThisRound === 1 ? '' : 'n'} je Spieler).`);
  touchRoom(room);
}

function beginBidding(room) {
  const n = room.players.length;
  room.bidQueue = [];
  for (let i = 1; i <= n; i++) {
    room.bidQueue.push(room.players[(room.dealerIndex + i) % n].id);
  }
  room.bidPointer = 0;
  room.phase = 'bidding';
}

function handleChooseTrump(room, playerId, suit) {
  if (room.phase !== 'trumpchoice') return;
  if (room.trumpChoiceById !== playerId) return;
  if (!SUITS.includes(suit)) return;
  room.trumpSuit = suit;
  log(room, `${findPlayer(room, playerId).name} bestimmt ${SUIT_INFO[suit].name} (${SUIT_INFO[suit].icon}) als Trumpffarbe.`);
  beginBidding(room);
  touchRoom(room);
  broadcastState(room);
}

function handleBid(room, playerId, value) {
  if (room.phase !== 'bidding') return;
  const bidder = currentBidder(room);
  if (!bidder || bidder.id !== playerId) return;
  const max = room.cardsThisRound;
  value = Math.round(Number(value));
  if (!Number.isFinite(value) || value < 0 || value > max) return;

  room.bids[playerId] = value;
  room.bidPointer += 1;
  log(room, `${bidder.name} sagt ${value} Stich${value === 1 ? '' : 'e'} vorher.`);

  if (room.bidPointer >= room.bidQueue.length) {
    room.phase = 'playing';
    const n = room.players.length;
    const leaderIdx = (room.dealerIndex + 1) % n;
    room.currentTurnIndex = leaderIdx;
    room.currentTrick = [];
  }
  touchRoom(room);
  broadcastState(room);
}

function finishTrick(room) {
  const winnerId = resolveTrick(room.currentTrick, room.trumpSuit);
  room.tricksWon[winnerId] = (room.tricksWon[winnerId] || 0) + 1;
  const winner = findPlayer(room, winnerId);
  log(room, `${winner.name} gewinnt den Stich.`);
  room.trickResult = { cards: room.currentTrick, winnerId };
  room.phase = 'trickresult';
  touchRoom(room);
  broadcastState(room);

  room.trickTimer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    room.currentTrick = [];
    room.trickResult = null;
    if (room.trickNumber >= room.cardsThisRound) {
      finishRound(room);
    } else {
      room.trickNumber += 1;
      room.currentTurnIndex = room.players.findIndex((p) => p.id === winnerId);
      room.phase = 'playing';
      touchRoom(room);
      broadcastState(room);
    }
  }, TRICK_RESULT_DELAY_MS);
}

function finishRound(room) {
  const entries = {};
  room.players.forEach((p) => {
    const bid = room.bids[p.id] || 0;
    const tricks = room.tricksWon[p.id] || 0;
    const points = bid === tricks ? 20 + 10 * tricks : -10 * Math.abs(bid - tricks);
    room.scores[p.id] = (room.scores[p.id] || 0) + points;
    entries[p.id] = { bid, tricks, points, total: room.scores[p.id] };
  });
  room.history.push({ round: room.roundNumber, entries });
  room.phase = 'roundend';
  room.roundReady = new Set();
  log(room, `Runde ${room.roundNumber} ausgewertet.`);
  touchRoom(room);

  // Bots sind sofort bereit für die nächste Runde.
  room.players.filter((p) => p.isBot).forEach((p) => room.roundReady.add(p.id));

  // Falls noch verbundene menschliche Spieler auf "bereit" klicken müssen,
  // läuft ein Zeitlimit mit - danach geht es automatisch weiter, damit ein
  // abwesender Mitspieler die Runde nicht unbegrenzt blockiert.
  const connectedHumans = room.players.filter((p) => !p.isBot && p.connected);
  const stillWaiting = !connectedHumans.every((p) => room.roundReady.has(p.id));
  if (stillWaiting) startRoundEndTimer(room);

  broadcastState(room);
  maybeAdvanceRound(room);
}

function startRoundEndTimer(room) {
  if (room.roundEndTimer) clearTimeout(room.roundEndTimer);
  room.roundEndDeadline = Date.now() + ROUND_END_TIMEOUT_MS;
  room.roundEndTimer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.phase !== 'roundend') return;
    log(room, 'Zeitlimit erreicht – weiter zur nächsten Runde.');
    room.players.forEach((p) => room.roundReady.add(p.id));
    room.roundEndTimer = null;
    room.roundEndDeadline = null;
    touchRoom(room);
    advanceRound(room);
  }, ROUND_END_TIMEOUT_MS);
}

function maybeAdvanceRound(room) {
  if (room.phase !== 'roundend') return;
  const connectedHumans = room.players.filter((p) => !p.isBot && p.connected);
  const allReady = connectedHumans.every((p) => room.roundReady.has(p.id));
  if (!allReady) return;
  if (room.roundEndTimer) { clearTimeout(room.roundEndTimer); room.roundEndTimer = null; }
  room.roundEndDeadline = null;
  advanceRound(room);
}

function advanceRound(room) {
  if (room.phase !== 'roundend') return;
  if (room.roundNumber >= room.maxRounds) {
    const top = Math.max(...room.players.map((p) => room.scores[p.id]));
    room.winnerIds = room.players.filter((p) => room.scores[p.id] === top).map((p) => p.id);
    room.phase = 'gameover';
    log(room, `Spiel beendet. Gewinner: ${room.winnerIds.map((id) => findPlayer(room, id).name).join(', ')}.`);
    touchRoom(room);
    broadcastState(room);
    return;
  }
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  startRound(room);
  broadcastState(room);
}

function handleReadyNextRound(room, playerId) {
  if (room.phase !== 'roundend') return;
  if (!findPlayer(room, playerId)) return;
  room.roundReady.add(playerId);
  touchRoom(room);
  broadcastState(room);
  maybeAdvanceRound(room);
}

function handlePlayCard(room, playerId, cardId) {
  if (room.phase !== 'playing') return;
  const turnPlayer = currentTurnPlayer(room);
  if (!turnPlayer || turnPlayer.id !== playerId) return;
  const hand = room.hands[playerId] || [];
  const card = hand.find((c) => c.id === cardId);
  if (!card) return;
  const legal = legalCardsFor(room, playerId);
  if (!legal.some((c) => c.id === cardId)) return;

  room.hands[playerId] = hand.filter((c) => c.id !== cardId);
  room.currentTrick.push({ playerId, card });

  if (room.currentTrick.length >= room.players.length) {
    finishTrick(room);
    return;
  }

  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
  touchRoom(room);
  broadcastState(room);
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

function addBot(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const usedNames = new Set(room.players.map((p) => p.name));
  const name = BOT_NAME_POOL.find((n) => !usedNames.has(n)) || `Bot ${room.players.length + 1}`;
  const bot = { id: makeId(), token: null, name, socketId: null, connected: true, isBot: true };
  room.players.push(bot);
  log(room, `${name} (Bot) wurde hinzugefügt.`);
  return bot;
}

// Verzögerungen für Bot-Aktionen und die "Stich gewonnen"-Anzeige sind über
// Umgebungsvariablen konfigurierbar, damit automatisierte Tests ein
// komplettes Spiel (bis zu 20 Runden) nicht in Echtzeit-Tempo durchspielen
// müssen. Produktion nutzt die menschlich wirkenden Standardwerte.
const BOT_DELAY_MIN = Number(process.env.BOT_DELAY_MIN_MS) || 1100;
const BOT_DELAY_MAX = Number(process.env.BOT_DELAY_MAX_MS) || 2400;
const TRICK_RESULT_DELAY_MS = Number(process.env.TRICK_RESULT_DELAY_MS) || 2600;
// Zeitlimit beim Warten auf "bereit" zwischen zwei Runden - danach geht es
// automatisch weiter, damit ein abwesender Mitspieler die Partie nicht
// unbegrenzt blockiert.
const ROUND_END_TIMEOUT_MS = Number(process.env.ROUND_END_TIMEOUT_MS) || 5000;

function randomDelay(min = BOT_DELAY_MIN, max = BOT_DELAY_MAX) {
  return min + Math.random() * (max - min);
}

function estimateBotBid(hand, trumpSuit) {
  let score = 0;
  hand.forEach((card) => {
    if (card.kind === 'wizard') score += 0.92;
    else if (card.kind === 'jester') score += 0.03;
    else if (trumpSuit && card.suit === trumpSuit) score += 0.22 + (card.value / 13) * 0.55;
    else score += Math.max(0, card.value - 7) / 13 * 0.5;
  });
  let bid = Math.round(score);
  if (Math.random() < 0.3) bid += Math.random() < 0.5 ? -1 : 1;
  return Math.max(0, Math.min(hand.length, bid));
}

function decideBotTrumpChoice(hand) {
  const counts = { blau: 0, gruen: 0, rot: 0, gelb: 0 };
  hand.forEach((c) => { if (c.kind === 'suit') counts[c.suit] += 1; });
  let best = SUITS[0];
  SUITS.forEach((s) => { if (counts[s] > counts[best]) best = s; });
  return best;
}

function wouldWinTrick(trick, candidate, playerId, trumpSuit) {
  const simulated = trick.concat([{ playerId, card: candidate }]);
  return resolveTrick(simulated, trumpSuit) === playerId;
}

function decideBotCard(room, bot) {
  const legal = legalCardsFor(room, bot.id);
  if (legal.length === 1) return legal[0];
  const wantsToWin = (room.tricksWon[bot.id] || 0) < (room.bids[bot.id] || 0);
  const rank = (c) => (c.kind === 'jester' ? -1 : c.kind === 'wizard' ? 100 : c.value);

  if (room.currentTrick.length === 0) {
    // Anspielen
    if (wantsToWin) {
      const sorted = legal.slice().sort((a, b) => rank(b) - rank(a));
      return sorted[0];
    }
    const sorted = legal.slice().sort((a, b) => rank(a) - rank(b));
    return sorted[0];
  }

  const winning = legal.filter((c) => wouldWinTrick(room.currentTrick, c, bot.id, room.trumpSuit));
  const losing = legal.filter((c) => !winning.includes(c));

  if (wantsToWin) {
    if (winning.length) {
      return winning.slice().sort((a, b) => rank(a) - rank(b))[0]; // knapp gewinnen, Zauberer sparen
    }
    return losing.slice().sort((a, b) => rank(a) - rank(b))[0];
  }
  if (losing.length) {
    return losing.slice().sort((a, b) => rank(b) - rank(a))[0]; // gefährliche Karten loswerden
  }
  return winning.slice().sort((a, b) => rank(a) - rank(b))[0];
}

function scheduleBotTurnIfNeeded(room) {
  if (room.phase === 'trumpchoice') {
    const chooser = findPlayer(room, room.trumpChoiceById);
    if (chooser && chooser.isBot) {
      const expected = room.trumpChoiceById;
      setTimeout(() => {
        if (!rooms.has(room.code)) return;
        if (room.phase !== 'trumpchoice' || room.trumpChoiceById !== expected) return;
        const suit = decideBotTrumpChoice(room.hands[chooser.id] || []);
        handleChooseTrump(room, chooser.id, suit);
      }, randomDelay());
    }
  } else if (room.phase === 'bidding') {
    const bidder = currentBidder(room);
    if (bidder && bidder.isBot) {
      const pointerAtSchedule = room.bidPointer;
      setTimeout(() => {
        if (!rooms.has(room.code)) return;
        if (room.phase !== 'bidding' || room.bidPointer !== pointerAtSchedule) return;
        const value = estimateBotBid(room.hands[bidder.id] || [], room.trumpSuit);
        handleBid(room, bidder.id, value);
      }, randomDelay());
    }
  } else if (room.phase === 'playing') {
    const turnPlayer = currentTurnPlayer(room);
    if (turnPlayer && turnPlayer.isBot) {
      const trickLenAtSchedule = room.currentTrick.length;
      const turnIdxAtSchedule = room.currentTurnIndex;
      setTimeout(() => {
        if (!rooms.has(room.code)) return;
        if (room.phase !== 'playing') return;
        if (room.currentTurnIndex !== turnIdxAtSchedule || room.currentTrick.length !== trickLenAtSchedule) return;
        const card = decideBotCard(room, turnPlayer);
        if (!card) return;
        handlePlayCard(room, turnPlayer.id, card.id);
      }, randomDelay());
    }
  } else if (room.phase === 'roundend') {
    maybeAdvanceRound(room);
  }
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, cb) => {
    try {
      if (isRateLimited(`createRoom:${getClientIp(socket)}`, 8, 60 * 1000)) {
        return cb({ ok: false, error: 'Zu viele neue Räume in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
      }
      if (rooms.size >= MAX_ROOMS) {
        return cb({ ok: false, error: 'Gerade sind zu viele Räume aktiv. Bitte versuche es in ein paar Minuten erneut.' });
      }
      name = (name || '').trim().slice(0, 20) || 'Spieler';
      const room = createRoom();
      const player = { id: makeId(), token: makeId(), name, socketId: socket.id, connected: true };
      room.hostId = player.id;
      room.players.push(player);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      log(room, `${name} hat den Raum erstellt.`);
      touchRoom(room);
      cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcastState(room);
    } catch (err) {
      cb({ ok: false, error: 'Raum konnte nicht erstellt werden.' });
    }
  });

  socket.on('joinRoom', ({ code, name, token }, cb) => {
    if (isRateLimited(`joinRoom:${getClientIp(socket)}`, 20, 60 * 1000)) {
      return cb({ ok: false, error: 'Zu viele Versuche in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
    }
    code = (code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Diesen Raum gibt es nicht.' });

    if (token) {
      const existing = room.players.find((p) => p.token === token);
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.playerId = existing.id;
        touchRoom(room);
        log(room, `${existing.name} ist wieder verbunden.`);
        cb({ ok: true, code: room.code, playerId: existing.id, token: existing.token, rejoined: true });
        broadcastState(room);
        return;
      }
    }

    if (room.phase !== 'lobby') {
      return cb({ ok: false, error: 'Das Spiel läuft bereits. Bitte warte auf die nächste Runde.' });
    }
    if (room.players.length >= MAX_PLAYERS) {
      return cb({ ok: false, error: `Der Raum ist bereits voll (max. ${MAX_PLAYERS} Spieler).` });
    }
    name = (name || '').trim().slice(0, 20) || 'Spieler';
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return cb({ ok: false, error: 'Dieser Name ist im Raum bereits vergeben.' });
    }
    const player = { id: makeId(), token: makeId(), name, socketId: socket.id, connected: true };
    room.players.push(player);
    if (!room.hostId) room.hostId = player.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    touchRoom(room);
    log(room, `${name} ist dem Raum beigetreten.`);
    cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
    broadcastState(room);
  });

  socket.on('leaveRoom', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;

    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p.id !== player.id);
      if (room.hostId === player.id) {
        room.hostId = room.players.length ? room.players[0].id : null;
      }
      log(room, `${player.name} hat den Raum verlassen.`);
    } else {
      player.connected = false;
      log(room, `${player.name} hat das Spiel verlassen.`);
    }

    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    touchRoom(room);
    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      broadcastState(room);
    }
  });

  socket.on('kickPlayer', ({ playerId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (playerId === room.hostId) return;
    room.players = room.players.filter((p) => p.id !== playerId);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('addBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    addBot(room);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('removeBot', ({ botId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    const bot = findPlayer(room, botId);
    if (!bot || !bot.isBot) return;
    room.players = room.players.filter((p) => p.id !== botId);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('fillBots', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    while (room.players.length < MIN_PLAYERS) addBot(room);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) return;
    startGame(room);
    broadcastState(room);
  });

  socket.on('chooseTrump', ({ suit }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    handleChooseTrump(room, socket.data.playerId, suit);
  });

  socket.on('placeBid', ({ value }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    handleBid(room, socket.data.playerId, value);
  });

  socket.on('playCard', ({ cardId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    handlePlayCard(room, socket.data.playerId, cardId);
  });

  socket.on('readyNextRound', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    handleReadyNextRound(room, socket.data.playerId);
  });

  socket.on('resetGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.trickTimer) clearTimeout(room.trickTimer);
    if (room.roundEndTimer) clearTimeout(room.roundEndTimer);
    room.roundEndTimer = null;
    room.roundEndDeadline = null;
    room.phase = 'lobby';
    room.hands = {};
    room.trumpCard = null;
    room.trumpSuit = null;
    room.trumpChoiceById = null;
    room.bids = {};
    room.tricksWon = {};
    room.currentTrick = [];
    room.trickResult = null;
    room.scores = {};
    room.history = [];
    room.winnerIds = null;
    room.roundNumber = 0;
    room.logs = [];
    log(room, 'Zurück zur Lobby. Bereit für eine neue Partie.');
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;
    player.connected = false;
    log(room, `${player.name} hat die Verbindung verloren.`);
    touchRoom(room);
    broadcastState(room);
  });
});

// Nur beim direkten Start ("node server.js") tatsächlich einen Port öffnen -
// nicht, wenn diese Datei nur per require() für Unit-Tests der exportierten
// Hilfsfunktionen (siehe module.exports unten) eingebunden wird.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Wizard läuft auf Port ${PORT}`);
    console.log(`Lokal öffnen unter: http://localhost:${PORT}`);
  });
}

module.exports = {
  buildDeck, shuffle, resolveTrick, ledSuitOfTrick, legalCardsFor,
  maxRoundsFor, SUITS, SUIT_INFO,
};
