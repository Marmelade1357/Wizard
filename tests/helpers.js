// Kleine Hilfsfunktionen für die Integrationstests unter tests/.
//
// Diese Tests starten den echten server.js als Kindprozess auf einem
// Test-Port und steuern das Spiel über einen echten socket.io-client -
// genau wie ein Browser es tun würde. Das prüft den kompletten Server-Code
// (Runden, Trumpf-Wahl, Vorhersage, Stiche, Punktevergabe) end-to-end,
// statt einzelne Funktionen isoliert zu testen.

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

function startServer(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(port) }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    const onData = (data) => {
      if (!started && data.toString().includes('läuft auf Port')) {
        started = true;
        proc.stdout.off('data', onData);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!started) reject(new Error(`Server (Port ${port}) beendete sich vorzeitig mit Code ${code}`));
    });
    setTimeout(() => { if (!started) reject(new Error('Timeout beim Serverstart')); }, 8000);
  });
}

function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) return resolve();
    proc.once('exit', () => resolve());
    proc.kill();
    setTimeout(resolve, 2000);
  });
}

function connectClient(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error('Timeout beim Verbinden mit dem Server')), 5000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function emitAsync(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout bei Event "${event}"`)), 5000);
    socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}

function waitForState(socket, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('gameState', handler);
      reject(new Error('Timeout beim Warten auf einen bestimmten Spielzustand'));
    }, timeoutMs);
    function handler(state) {
      if (predicate(state)) {
        clearTimeout(timer);
        socket.off('gameState', handler);
        resolve(state);
      }
    }
    socket.on('gameState', handler);
  });
}

// Hängt einen simplen "Autopilot" an einen Test-Client: er verhält sich wie
// ein einfacher, immer mitspielender Teilnehmer (wählt eine Trumpffarbe,
// sagt einen zufälligen Stich-Wert vorher, spielt die erste legale Karte,
// bestätigt jede Runde). Die eigentlichen Bots im Raum handeln bereits
// selbstständig serverseitig - der Autopilot deckt nur den einen "echten"
// Test-Client ab, damit das Spiel unabhängig davon durchläuft, wer zufällig
// Kartengeber/Zauberer-Trumpfwahl bekommt.
function attachAutopilot(socket, getMyId) {
  let myLegal = null;
  let lastState = null;

  // 'gameState' und 'yourHand' treffen für einen Zug, bei dem man selbst am
  // Zug ist, als zwei getrennte Events ein (Server sendet erst den
  // öffentlichen Zustand, dann pro Spieler die private Hand). Welches der
  // beiden zuletzt eintrifft, ist nicht garantiert - daher wird nach BEIDEN
  // Events erneut geprüft, ob jetzt gehandelt werden kann.
  function maybeAct() {
    const state = lastState;
    const myId = getMyId();
    if (!state || !myId) return;

    if (state.phase === 'trumpchoice' && state.trumpChoiceById === myId) {
      const suits = Object.keys(state.suits || { blau: 1, gruen: 1, rot: 1, gelb: 1 });
      socket.emit('chooseTrump', { suit: suits[Math.floor(Math.random() * suits.length)] });
      return;
    }
    if (state.phase === 'bidding' && state.currentBidderId === myId) {
      const value = Math.floor(Math.random() * (state.cardsThisRound + 1));
      socket.emit('placeBid', { value });
      return;
    }
    if (state.phase === 'playing' && state.currentTurnId === myId && myLegal && myLegal.length) {
      const cardId = myLegal[0];
      myLegal = null;
      socket.emit('playCard', { cardId });
      return;
    }
    if (state.phase === 'roundend' && !(state.roundReady || []).includes(myId)) {
      socket.emit('readyNextRound');
    }
  }

  socket.on('yourHand', (h) => {
    myLegal = h.legalCardIds;
    maybeAct();
  });

  socket.on('gameState', (state) => {
    lastState = state;
    maybeAct();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion fehlgeschlagen: ${message}`);
}

module.exports = { startServer, stopServer, connectClient, emitAsync, waitForState, attachAutopilot, assert };
