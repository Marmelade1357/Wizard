// Unit-Tests für die Kern-Spiellogik (Deck, Stich-Gewinner-Ermittlung,
// erlaubte Karten). Läuft ohne echten Netzwerk-Client - bindet den Server
// nur an einen Zufallsport (PORT=0), damit require('../server.js') keinen
// Konflikt mit anderen Tests verursacht.

process.env.PORT = '0';
const assert = require('assert');
const { buildDeck, resolveTrick, ledSuitOfTrick, legalCardsFor, maxRoundsFor, SUITS } = require('../server.js');

function play(playerId, card) { return { playerId, card }; }
function suitCard(suit, value) { return { id: `${suit}${value}`, kind: 'suit', suit, value }; }
function wizard(n = 1) { return { id: `z${n}`, kind: 'wizard' }; }
function jester(n = 1) { return { id: `n${n}`, kind: 'jester' }; }

// --- Deck ---
const deck = buildDeck();
assert.strictEqual(deck.length, 60, `Deck sollte 60 Karten haben, hat aber ${deck.length}`);
assert.strictEqual(new Set(deck.map((c) => c.id)).size, 60, 'Alle Karten-IDs sollten eindeutig sein');
SUITS.forEach((s) => {
  assert.strictEqual(deck.filter((c) => c.kind === 'suit' && c.suit === s).length, 13, `Farbe ${s} sollte 13 Karten haben`);
});
assert.strictEqual(deck.filter((c) => c.kind === 'wizard').length, 4, 'Es sollte 4 Zauberer geben');
assert.strictEqual(deck.filter((c) => c.kind === 'jester').length, 4, 'Es sollte 4 Narren geben');

// --- maxRoundsFor ---
assert.strictEqual(maxRoundsFor(3), 20);
assert.strictEqual(maxRoundsFor(4), 15);
assert.strictEqual(maxRoundsFor(5), 12);
assert.strictEqual(maxRoundsFor(6), 10);

// --- resolveTrick ---

// 1) Ein Zauberer schlägt jede andere Karte.
{
  const trick = [play('a', suitCard('blau', 13)), play('b', wizard()), play('c', suitCard('blau', 5))];
  assert.strictEqual(resolveTrick(trick, null), 'b', 'Zauberer sollte den Stich gewinnen');
}

// 2) Der ERSTE Zauberer gewinnt, auch wenn ein zweiter folgt.
{
  const trick = [play('a', wizard(1)), play('b', wizard(2)), play('c', suitCard('rot', 1))];
  assert.strictEqual(resolveTrick(trick, null), 'a', 'Der erste Zauberer sollte gewinnen');
}

// 3) Werden nur Narren gespielt, gewinnt der erste.
{
  const trick = [play('a', jester(1)), play('b', jester(2)), play('c', jester(3))];
  assert.strictEqual(resolveTrick(trick, 'rot'), 'a', 'Bei reinem Narren-Stich gewinnt der erste Narr');
}

// 4) Trumpf schlägt die angespielte Farbe, unabhängig vom Wert.
{
  const trick = [play('a', suitCard('blau', 13)), play('b', suitCard('rot', 2)), play('c', suitCard('blau', 7))];
  assert.strictEqual(resolveTrick(trick, 'rot'), 'b', 'Einzige Trumpfkarte sollte gewinnen, auch mit niedrigem Wert');
}

// 5) Unter mehreren Trümpfen gewinnt der höchste.
{
  const trick = [play('a', suitCard('rot', 5)), play('b', suitCard('rot', 9)), play('c', suitCard('blau', 13))];
  assert.strictEqual(resolveTrick(trick, 'rot'), 'b', 'Höchster Trumpf sollte gewinnen');
}

// 6) Ohne Trumpf/Zauberer gewinnt die höchste Karte der zuerst gespielten Farbe.
{
  const trick = [play('a', suitCard('blau', 10)), play('b', suitCard('rot', 12)), play('c', suitCard('blau', 3))];
  assert.strictEqual(resolveTrick(trick, null), 'a', 'Höchste Karte der angespielten Farbe (blau) sollte gewinnen, nicht die andersfarbige 12');
}

// 7) Ein Narr zu Beginn verzögert nur, welche Karte die Farbe festlegt.
{
  const trick = [play('a', jester(1)), play('b', suitCard('blau', 7)), play('c', suitCard('blau', 2))];
  assert.strictEqual(ledSuitOfTrick(trick), 'blau', 'Die Farbe sollte von der ersten Nicht-Narren-Karte kommen');
  assert.strictEqual(resolveTrick(trick, null), 'b', 'Höchste blaue Karte gewinnt, der Narr scheidet aus');
}

// 8) Wird mit einem Zauberer eröffnet, ist die Farbe für immer offen.
{
  const trick = [play('a', wizard()), play('b', suitCard('blau', 2))];
  assert.strictEqual(ledSuitOfTrick(trick), null, 'Nach einem eröffnenden Zauberer gibt es keine bindende Farbe mehr');
}

// --- legalCardsFor ---

function fakeRoom(hand, trick) {
  return { phase: 'playing', hands: { p1: hand }, currentTrick: trick };
}

// Muss bedienen, wenn möglich.
{
  const hand = [suitCard('gelb', 4), suitCard('blau', 9), wizard(), jester()];
  const trick = [play('x', suitCard('gelb', 8))];
  const legal = legalCardsFor(fakeRoom(hand, trick), 'p1').map((c) => c.id);
  assert.deepStrictEqual(new Set(legal), new Set(['gelb4', 'z1', 'n1']), 'Sollte nur die angespielte Farbe plus Zauberer/Narren erlauben');
}

// Ohne passende Farbe darf alles gespielt werden.
{
  const hand = [suitCard('blau', 9), suitCard('rot', 3)];
  const trick = [play('x', suitCard('gelb', 8))];
  const legal = legalCardsFor(fakeRoom(hand, trick), 'p1').map((c) => c.id);
  assert.deepStrictEqual(new Set(legal), new Set(['blau9', 'rot3']), 'Ohne passende Farbe sollte die ganze Hand erlaubt sein');
}

// Beim Anspielen (leerer Stich) ist alles erlaubt.
{
  const hand = [suitCard('blau', 9), jester()];
  const legal = legalCardsFor(fakeRoom(hand, []), 'p1').map((c) => c.id);
  assert.deepStrictEqual(new Set(legal), new Set(['blau9', 'n1']), 'Beim Anspielen ist die ganze Hand erlaubt');
}

console.log('OK: trick-rules.test.js');
process.exit(0);
