# Wizard – Online

Eine browserbasierte Online-Version des Kartenspiels **"Wizard"** (AMIGO) zum Spielen mit Freunden – jede:r auf dem eigenen Handy/Tablet/PC, ein gemeinsamer Server übernimmt Kartenverteilung, Trumpf-Ermittlung, Vorhersagen, Stiche und die Punkteabrechnung.

Basiert auf dem offiziellen Regelwerk (Grundspiel, siehe `Spielanleitung_Wizard.pdf`): 3–6 Spieler, 60 Karten (4 Farben à 1–13, 4 Zauberer, 4 Narren), Rundenzahl je nach Spielerzahl (3 Spieler → 20 Runden, 4 → 15, 5 → 12, 6 → 10).

## Funktionen

- **Automatisches Austeilen** – die Rundenkarten (Runde 1 = 1 Karte, Runde 2 = 2 Karten, ...) werden gemischt und verteilt, kein Kartenmischen nötig.
- **Trumpf-Ermittlung** – die oberste Karte des Reststapels bestimmt die Trumpffarbe. Ist sie ein Narr, gibt es keinen Trumpf; ist sie ein Zauberer, bestimmt der Kartengeber der Runde die Trumpffarbe per Klick. In der letzten Runde (alle Karten verteilt) gibt es folgerichtig keinen Trumpf.
- **Vorhersage-Phase** – reihum (beginnend links vom Kartengeber, der Kartengeber selbst zuletzt) sagt jede:r die Anzahl der Stiche vorher; alle bereits abgegebenen Tipps sind sofort für alle sichtbar.
- **Stich-Logik nach Originalregeln** – Farbzwang, Zauberer/Narren dürfen immer gespielt werden und müssen keine Farbe bedienen, der erste gespielte Zauberer gewinnt immer, ohne Zauberer gewinnt der höchste Trumpf, sonst die höchste Karte der zuerst gespielten Farbe. Werden in einem Stich ausschließlich Narren gespielt, gewinnt der erste.
- **Punkteblock ("Der Block der Wahrheit")** – jederzeit über den Button oben rechts einsehbar: pro Runde und Spieler Tipp, gemachte Stiche, Punkte dieser Runde und Gesamtpunktestand.
- **Test-Bots** – allein oder zu zweit Lust zu testen? Der Raum lässt sich in der Lobby per Klick mit Bots auf die Mindestspielerzahl (3) auffüllen. Bots sagen Stiche anhand einer einfachen Handbewertung vorher (Zauberer und hohe Trumpfkarten zählen mehr) und spielen beim Stich taktisch: Sie versuchen, offene Vorhersagen zu erfüllen (knapp gewinnen, ohne unnötig Zauberer zu verbrauchen) oder gezielt zu verlieren (gefährliche hohe Karten abwerfen), jeweils mit kleiner, realistisch wirkender Verzögerung.
- Wiederverbindung nach Verbindungsabbruch/Neuladen der Seite (Sitzplatz, Hand und Punktestand bleiben erhalten).
- Läuft komplett im Speicher – keine Datenbank nötig, ideal für einen Raspberry Pi.

## Anpassungen für die Online-Version

Das Regelwerk lässt an ein paar Stellen bewusst Spielraum bzw. macht Angaben, die online leicht anders gelöst werden:

- Beim Grundspiel gibt es laut Anleitung **keine Einschränkung** der Vorhersagen (das ist erst die Variante "Plus/minus Eins") – hier umgesetzt wie im Original: völlig freie Tipps.
- Trifft ein Zauberer als aufgedeckte Trumpfkarte auf einen Kartengeber, der ein Bot ist, wählt der Bot die Farbe, von der er selbst die meisten Karten auf der Hand hat.
- Die Rundenzusammenfassung muss von allen (menschlichen) Mitspieler:innen per "Bereit"-Klick bestätigt werden, bevor die nächste Runde beginnt – Bots bestätigen sofort automatisch.

## Nicht enthaltene Varianten

Aus der Anleitung sind aktuell **nur die Grundregeln** umgesetzt. Die im Regelwerk beschriebenen Varianten (Plus/minus Eins, Verdeckter Tipp, Geheime Vorhersage, Hellsehen, Einfarbig) sind (noch) nicht implementiert.

## Entwicklung

```bash
npm install
npm start          # http://localhost:3000
npm test           # Integrationstests (kompletter Spielablauf + Stich-Regeln)
```

## Deployment (Raspberry Pi, analog zu "Der Widerstand")

```bash
./deploy.sh
```

Der Container lauscht intern auf Port 3000 und wird laut `docker-compose.yml` nur auf `127.0.0.1:8093` veröffentlicht – ein bereits laufender Reverse Proxy auf dem Pi kann eine eigene Subdomain (z. B. `wizard.oualid.de`) dorthin routen, genau wie bei `wd.oualid.de` → 8092 für "Der Widerstand". Port 8093 wurde gewählt, weil 8080/8081/8090/8091/8092/8443 bereits von den anderen Projekten (FinanceAgent, Monitoring Shop, Widerstand) belegt sind.
