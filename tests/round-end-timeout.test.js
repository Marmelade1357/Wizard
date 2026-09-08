// Regressionstest: Wartet ein menschlicher Spieler nach einer Runde zu lange,
// ohne auf "bereit" zu klicken, geht es nach einem Zeitlimit automatisch
// weiter (statt die Partie unbegrenzt zu blockieren).
//
// Der Test-Client klickt bewusst NIE "bereit" - Bots sind laut Server sofort
// bereit, der einzige verbleibende Blocker ist also der Mensch. Ohne die
// Zeitlimit-Funktion würde der Test hier stehen bleiben (Timeout durch
// waitForState), statt automatisch in Runde 2 weiterzugehen.

const { startServer, stopServer, connectClient, emitAsync, waitForState, assert } = require('./helpers');

const PORT = 3905;
const ROUND_END_TIMEOUT_MS = 1200;

async function main() {
  const proc = await startServer(PORT, {
    BOT_DELAY_MIN_MS: '5',
    BOT_DELAY_MAX_MS: '15',
    TRICK_RESULT_DELAY_MS: '10',
    ROUND_END_TIMEOUT_MS: String(ROUND_END_TIMEOUT_MS),
  });
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);
    let myId = null;
    let myLegal = null;
    let lastState = null;

    // Minimaler Autopilot NUR für Trumpfwahl/Vorhersage/Stich (damit Runde 1
    // überhaupt zu Ende gespielt wird) - aber bewusst OHNE die "roundend"-
    // Behandlung von attachAutopilot(), die sofort "readyNextRound" senden
    // würde. Wie beim echten attachAutopilot() (siehe helpers.js) wird nach
    // BEIDEN Events "yourHand" und "gameState" erneut geprüft, da ihre
    // Ankunftsreihenfolge nicht garantiert ist.
    function maybeAct() {
      const state = lastState;
      if (!state || !myId) return;
      if (state.phase === 'trumpchoice' && state.trumpChoiceById === myId) {
        const suits = Object.keys(state.suits || {});
        host.emit('chooseTrump', { suit: suits[0] });
      } else if (state.phase === 'bidding' && state.currentBidderId === myId) {
        host.emit('placeBid', { value: 0 });
      } else if (state.phase === 'playing' && state.currentTurnId === myId && myLegal && myLegal.length) {
        const cardId = myLegal[0];
        myLegal = null;
        host.emit('playCard', { cardId });
      }
      // phase === 'roundend': absichtlich nichts tun.
    }
    host.on('yourHand', (h) => { myLegal = h.legalCardIds; maybeAct(); });
    host.on('gameState', (state) => { lastState = state; maybeAct(); });

    const created = await emitAsync(host, 'createRoom', { name: 'TestHost' });
    assert(created.ok, `createRoom fehlgeschlagen: ${JSON.stringify(created)}`);
    myId = created.playerId;

    host.emit('fillBots');
    await waitForState(host, (s) => s.players.length === 3);

    host.emit('startGame');

    const roundEndState = await waitForState(host, (s) => s.phase === 'roundend');
    assert(roundEndState.roundNumber === 1, `Sollte nach Runde 1 im roundend-Zustand sein, war aber Runde ${roundEndState.roundNumber}`);
    assert(
      typeof roundEndState.roundEndDeadline === 'number' && roundEndState.roundEndDeadline > Date.now(),
      `roundEndDeadline sollte ein zukünftiger Zeitstempel sein, war aber ${roundEndState.roundEndDeadline}`
    );

    const t0 = Date.now();
    const advancedState = await waitForState(host, (s) => s.roundNumber >= 2, ROUND_END_TIMEOUT_MS + 8000);
    const elapsed = Date.now() - t0;

    assert(advancedState.roundNumber === 2, `Sollte automatisch in Runde 2 weitergegangen sein, war aber Runde ${advancedState.roundNumber}`);
    assert(
      elapsed >= ROUND_END_TIMEOUT_MS - 250,
      `Es ist deutlich zu früh weitergegangen (${elapsed}ms) - das Zeitlimit (${ROUND_END_TIMEOUT_MS}ms) wurde offenbar nicht abgewartet`
    );

    console.log(`OK: round-end-timeout.test.js (automatisch weiter nach ${elapsed}ms, Limit war ${ROUND_END_TIMEOUT_MS}ms)`);
  } finally {
    await stopServer(proc);
  }
}

main().catch((err) => {
  console.error('FEHLER in round-end-timeout.test.js:', err);
  process.exitCode = 1;
});
