// Regressionstest: Beim Start einer Partie wird die Sitz-/Zugreihenfolge der
// Spieler zufällig gemischt - unabhängig davon, in welcher Reihenfolge sie
// dem Raum beigetreten sind. Vorher war nur der Kartengeber zufällig, die
// relative Reihenfolge (wer nach wem kommt) blieb aber immer exakt die
// Beitrittsreihenfolge.
//
// Statistischer Test: Host + 3 Bots treten in jeder Testrunde in derselben
// Reihenfolge bei ("TestHost", "Bot Merlin", "Bot Morgana", "Bot Gandalf").
// Über mehrere unabhängige Partien hinweg muss die tatsächliche Spielreihenfolge
// (state.players Namensliste direkt nach Spielstart) variieren - würde nicht
// gemischt, wäre sie bei jedem Durchlauf exakt identisch zur Beitrittsreihenfolge.

const { startServer, stopServer, connectClient, emitAsync, waitForState, assert } = require('./helpers');

const PORT = 3904;
// Bleibt bewusst unter dem createRoom-Rate-Limit des Servers (8 pro Minute
// und IP) - alle Testdurchläufe laufen aus Sicht des Servers von derselben
// Adresse und in wenigen Sekunden.
const TRIALS = 6;

async function runOneTrial(url) {
  const host = await connectClient(url);
  try {
    const created = await emitAsync(host, 'createRoom', { name: 'TestHost' });
    assert(created.ok, `createRoom fehlgeschlagen: ${JSON.stringify(created)}`);

    host.emit('addBot');
    host.emit('addBot');
    host.emit('addBot');
    const lobbyState = await waitForState(host, (s) => s.players.length === 4);
    assert(lobbyState.players.length === 4, 'Sollte 4 Spieler in der Lobby haben');

    host.emit('startGame');
    const state = await waitForState(host, (s) => s.phase !== 'lobby');
    return state.players.map((p) => p.name);
  } finally {
    host.emit('leaveRoom');
    host.disconnect();
  }
}

async function main() {
  const proc = await startServer(PORT, { BOT_DELAY_MIN_MS: '5', BOT_DELAY_MAX_MS: '15' });
  try {
    const url = `http://localhost:${PORT}`;
    const joinOrder = ['TestHost', 'Bot Merlin', 'Bot Morgana', 'Bot Gandalf'];
    const orders = [];
    for (let i = 0; i < TRIALS; i++) {
      orders.push(await runOneTrial(url));
    }

    orders.forEach((order, i) => {
      assert(order.length === 4, `Durchlauf ${i}: sollte 4 Spieler enthalten, waren aber ${order.length}`);
      joinOrder.forEach((name) => {
        assert(order.includes(name), `Durchlauf ${i}: "${name}" fehlt in der Spielreihenfolge ${JSON.stringify(order)}`);
      });
    });

    const signatures = new Set(orders.map((o) => o.join('|')));
    assert(
      signatures.size > 1,
      `Die Spielreihenfolge war in allen ${TRIALS} Durchläufen identisch (${JSON.stringify(orders[0])}) - ` +
      'das deutet darauf hin, dass die Reihenfolge beim Spielstart nicht (mehr) gemischt wird.'
    );

    const matchesJoinOrder = orders.filter((o) => o.join('|') === joinOrder.join('|')).length;
    assert(
      matchesJoinOrder < TRIALS,
      `Die Spielreihenfolge entsprach in allen ${TRIALS} Durchläufen exakt der Beitrittsreihenfolge - ` +
      'das ist bei echtem Mischen statistisch praktisch ausgeschlossen.'
    );

    console.log(`OK: player-order-shuffle.test.js (${signatures.size}/${TRIALS} unterschiedliche Reihenfolgen beobachtet)`);
  } finally {
    await stopServer(proc);
  }
}

main().catch((err) => {
  console.error('FEHLER in player-order-shuffle.test.js:', err);
  process.exitCode = 1;
});
