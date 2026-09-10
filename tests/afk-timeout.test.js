// Regressionstest für das AFK-Timeout: Eine verbundene, aber untätige Person
// (z. B. gesperrtes Handy) bei der Trumpfwahl, der Stichansage oder beim
// Kartenspiel wird nach der eingestellten Zeit automatisch übersprungen - mit
// einem sicheren, harmlosen Standardzug (häufigste Farbe der eigenen Hand,
// Ansage 0, erste regelkonforme Karte) -, damit niemand die Runde unbegrenzt
// blockiert. Prüft außerdem, dass der Host diese Funktion in den Lobby-
// Einstellungen abschalten kann. Das bereits bestehende Runden-Ende-Zeitlimit
// (siehe round-end-timeout.test.js) ist davon unabhängig und bleibt unberührt.

const { startServer, stopServer, connectClient, emitAsync, waitForState, assert } = require('./helpers');

const AFK_TIMEOUT_MS = 300;
const FAST_ENV = {
  AFK_TIMEOUT_MS: String(AFK_TIMEOUT_MS),
  BOT_DELAY_MIN_MS: '20',
  BOT_DELAY_MAX_MS: '40',
  TRICK_RESULT_DELAY_MS: '20',
};

function myTurnPredicate(myId) {
  return (s) => (
    (s.phase === 'trumpchoice' && s.trumpChoiceById === myId)
    || (s.phase === 'bidding' && s.currentBidderId === myId)
    || (s.phase === 'playing' && s.currentTurnId === myId)
  );
}

function stillMyTurn(s, myId, phase) {
  if (phase === 'trumpchoice') return s.phase === 'trumpchoice' && s.trumpChoiceById === myId;
  if (phase === 'bidding') return s.phase === 'bidding' && s.currentBidderId === myId;
  return s.phase === 'playing' && s.currentTurnId === myId;
}

async function testEnabled() {
  const PORT = 3940;
  const proc = await startServer(PORT, FAST_ENV);
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);

    const created = await emitAsync(host, 'createRoom', { name: 'AFKHuman' });
    assert(created.ok, `createRoom fehlgeschlagen: ${JSON.stringify(created)}`);
    const myId = created.playerId;

    host.emit('addBot');
    host.emit('addBot');
    await waitForState(host, (s) => s.players.length === 3);
    host.emit('startGame');

    // Bewusst KEINE Aktion senden, egal in welcher der drei Phasen wir dran
    // sind - simuliert genau das Szenario "Handy gesperrt, Person reagiert
    // nicht", ganz gleich ob bei Trumpfwahl, Ansage oder Kartenspiel.
    const myTurnState = await waitForState(host, myTurnPredicate(myId), 15000);
    const myPhase = myTurnState.phase;
    const t0 = Date.now();

    const afterState = await waitForState(host, (s) => !stillMyTurn(s, myId, myPhase), AFK_TIMEOUT_MS + 5000);
    const elapsed = Date.now() - t0;

    assert(
      elapsed >= AFK_TIMEOUT_MS - 100,
      `Zug wurde zu früh übersprungen (${elapsed}ms, Limit war ${AFK_TIMEOUT_MS}ms) - das AFK-Timeout wurde offenbar nicht abgewartet`
    );
    assert(!stillMyTurn(afterState, myId, myPhase), `Es sollte nach dem AFK-Timeout automatisch weitergegangen sein (Phase war: ${myPhase})`);

    console.log(`OK: afk-timeout.test.js - aktiviert (Phase "${myPhase}" nach ${elapsed}ms automatisch übersprungen)`);
  } finally {
    await stopServer(proc);
  }
}

async function testDisabled() {
  const PORT = 3941;
  const proc = await startServer(PORT, FAST_ENV);
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);
    let latestState = null;
    host.on('gameState', (s) => { latestState = s; });

    const created = await emitAsync(host, 'createRoom', { name: 'AFKHuman2' });
    assert(created.ok, `createRoom fehlgeschlagen: ${JSON.stringify(created)}`);
    const myId = created.playerId;

    host.emit('setAfkTimeoutEnabled', { enabled: false });
    host.emit('addBot');
    host.emit('addBot');
    await waitForState(host, (s) => s.players.length === 3 && s.afkTimeoutEnabled === false);
    host.emit('startGame');

    const myTurnState = await waitForState(host, myTurnPredicate(myId), 15000);
    const myPhase = myTurnState.phase;

    // Deutlich länger als AFK_TIMEOUT_MS warten, ohne selbst zu handeln - bei
    // abgeschaltetem Timeout darf der Server NICHT automatisch für uns handeln.
    await new Promise((resolve) => setTimeout(resolve, AFK_TIMEOUT_MS * 4));

    assert(stillMyTurn(latestState, myId, myPhase), `Bei abgeschaltetem AFK-Timeout sollte die Phase "${myPhase}" NICHT automatisch weitergegangen sein`);

    console.log(`OK: afk-timeout.test.js - abgeschaltet (Phase "${myPhase}", kein automatischer Zug)`);
  } finally {
    await stopServer(proc);
  }
}

async function main() {
  await testEnabled();
  await testDisabled();
}

main().catch((err) => {
  console.error('FEHLER in afk-timeout.test.js:', err);
  process.exitCode = 1;
});
