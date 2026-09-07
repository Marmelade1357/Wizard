// Regressionstest für den kompletten Spielablauf: Raum erstellen, mit Bots
// auffüllen, Spiel starten und bis zum Spielende durchspielen (3 Spieler,
// also 20 Runden). Prüft vor allem, dass der Server dabei nicht abstürzt
// oder hängen bleibt, und dass am Ende ein konsistentes Ergebnis steht.

const { startServer, stopServer, connectClient, emitAsync, waitForState, attachAutopilot, assert } = require('./helpers');

const PORT = 3902;

async function main() {
  // Bot- und Anzeige-Verzögerungen für den Test drastisch verkürzen, damit ein
  // komplettes 20-Runden-Spiel (3 Spieler) nicht mehrere Minuten in
  // Echtzeit-Tempo braucht.
  const proc = await startServer(PORT, {
    BOT_DELAY_MIN_MS: '5',
    BOT_DELAY_MAX_MS: '15',
    TRICK_RESULT_DELAY_MS: '10',
  });
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);
    let myId = null;
    attachAutopilot(host, () => myId);

    const created = await emitAsync(host, 'createRoom', { name: 'TestHost' });
    assert(created.ok, `createRoom sollte erfolgreich sein, war aber: ${JSON.stringify(created)}`);
    myId = created.playerId;

    host.emit('fillBots');
    const lobbyState = await waitForState(host, (s) => s.players.length === 3);
    assert(lobbyState.players.length === 3, 'Raum sollte nach fillBots 3 Spieler haben (Minimum)');
    assert(lobbyState.maxPlayers === 6, 'maxPlayers sollte 6 sein');

    host.emit('startGame');
    await waitForState(host, (s) => s.phase !== 'lobby');

    const finalState = await waitForState(host, (s) => s.phase === 'gameover', 180000);

    assert(finalState.maxRounds === 20, `Bei 3 Spielern sollten es 20 Runden sein, waren aber ${finalState.maxRounds}`);
    assert(finalState.history.length === 20, `Es sollten 20 Runden-Einträge in der Historie stehen, waren aber ${finalState.history.length}`);
    assert(Array.isArray(finalState.winnerIds) && finalState.winnerIds.length >= 1, 'Es sollte mindestens einen Gewinner geben');

    const ids = finalState.players.map((p) => p.id);
    ids.forEach((id) => {
      assert(typeof finalState.scores[id] === 'number', `Spieler ${id} sollte einen numerischen Punktestand haben`);
    });

    // Punkte-Konsistenz: für jede Runde muss pro Spieler bid/tricks/points zur Formel passen,
    // und die Summe der in einer Runde gewonnenen Stiche muss der Rundengröße entsprechen.
    finalState.history.forEach((round) => {
      let totalTricks = 0;
      ids.forEach((id) => {
        const e = round.entries[id];
        assert(e, `Runde ${round.round}: Eintrag für Spieler ${id} fehlt`);
        const expected = e.bid === e.tricks ? 20 + 10 * e.tricks : -10 * Math.abs(e.bid - e.tricks);
        assert(e.points === expected, `Runde ${round.round}, Spieler ${id}: Punkte ${e.points} != erwartet ${expected}`);
        totalTricks += e.tricks;
      });
      assert(totalTricks === round.round, `Runde ${round.round}: Summe der Stiche (${totalTricks}) sollte der Kartenzahl entsprechen`);
    });

    console.log('OK: basic-game-flow.test.js');
  } finally {
    await stopServer(proc);
  }
}

main().catch((err) => {
  console.error('FEHLER in basic-game-flow.test.js:', err);
  process.exitCode = 1;
});
