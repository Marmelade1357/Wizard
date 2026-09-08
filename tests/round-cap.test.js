// Regressionstest: Die maximale Rundenzahl einer Partie ist immer an die
// Spielerzahl gekoppelt (60 Karten insgesamt / Spielerzahl), damit im
// letzten möglichen Zug nie mehr Karten verteilt werden müssten, als das
// Deck noch hat. Insbesondere: bei 6 Spielern maximal 10 Runden.
//
// Reiner Funktionstest ohne Server - prüft direkt die exportierte
// maxRoundsFor()-Funktion aus server.js.

const { maxRoundsFor } = require('../server.js');
const { assert } = require('./helpers');

function main() {
  const expected = { 3: 20, 4: 15, 5: 12, 6: 10 };
  Object.entries(expected).forEach(([players, rounds]) => {
    const got = maxRoundsFor(Number(players));
    assert(got === rounds, `maxRoundsFor(${players}) sollte ${rounds} sein, war aber ${got}`);
  });
  console.log('OK: round-cap.test.js');
}

main();
