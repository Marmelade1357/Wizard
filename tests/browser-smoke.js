// Manueller Browser-Smoke-Test (nicht Teil von `npm test`): startet den
// Server mit kurzen Bot-Verzögerungen, öffnet die echte UI in Chromium und
// klickt sich als "Autopilot" über die tatsächlich gerenderten Buttons durch
// mehrere Runden. Prüft, dass die UI (nicht nur der Server) fehlerfrei
// durchläuft: Lobby -> Bots auffüllen -> Start -> Trumpfwahl/Vorhersage/
// Stiche über mehrere Runden -> Punkteblock-Modal.

const path = require('path');
const { chromium } = require('playwright');
const { startServer, stopServer } = require('./helpers');

const PORT = 3960;

async function main() {
  const proc = await startServer(PORT, { BOT_DELAY_MIN_MS: '30', BOT_DELAY_MAX_MS: '80', TRICK_RESULT_DELAY_MS: '50' });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() =>
    chromium.launch());
  const consoleErrors = [];
  try {
    const page = await browser.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

    await page.goto(`http://localhost:${PORT}`);
    await page.fill('#create-name', 'Browsertest');
    await page.click('#btn-create');
    await page.waitForSelector('#screen-lobby:not(.hidden)', { timeout: 5000 });
    console.log('Lobby geladen.');

    await page.click('#btn-fill-bots');
    await page.waitForFunction(() => document.getElementById('lobby-count').textContent === '3', { timeout: 5000 });
    console.log('Bots aufgefüllt (3 Spieler).');

    await page.click('#btn-start');
    await page.waitForSelector('#screen-game:not(.hidden)', { timeout: 5000 });
    console.log('Spielbildschirm sichtbar.');

    // Autopilot: bis zu 90s lang jede sichtbare, klickbare Aktion ausführen,
    // bis das Punkteblock-Modal mindestens 2 abgeschlossene Runden zeigt.
    const deadline = Date.now() + 90000;
    let roundsSeen = 0;
    while (Date.now() < deadline && roundsSeen < 2) {
      const suitBtn = await page.$('.suit-btn');
      if (suitBtn) { await suitBtn.click(); await page.waitForTimeout(150); continue; }

      const bidBtn = await page.$('.bid-btn');
      if (bidBtn) { await bidBtn.click(); await page.waitForTimeout(150); continue; }

      const cardBtn = await page.$('.hand-list .pcard:not(.disabled)');
      if (cardBtn) { await cardBtn.click(); await page.waitForTimeout(150); continue; }

      const readyBtn = await page.$('#phase-content button.btn.primary');
      if (readyBtn) {
        const txt = (await readyBtn.textContent()) || '';
        if (txt.includes('Bereit') || txt.includes('Endauswertung')) {
          await readyBtn.click();
          roundsSeen++;
          console.log(`Runde ${roundsSeen} bestätigt.`);
          await page.waitForTimeout(150);
          continue;
        }
      }
      await page.waitForTimeout(200);
    }

    if (roundsSeen < 2) throw new Error(`Nur ${roundsSeen} Runden erreicht, Autopilot hängt vermutlich fest.`);

    await page.click('#btn-show-scores');
    await page.waitForSelector('#scores-modal:not(.hidden)');
    const rowCount = await page.$$eval('#scores-table-wrap tbody tr', (rows) => rows.length);
    console.log(`Punkteblock zeigt ${rowCount} Runden-Zeilen.`);
    if (rowCount < 2) throw new Error('Punkteblock zeigt zu wenige Runden.');

    if (consoleErrors.length) {
      throw new Error('Browser-Konsole meldete Fehler:\n' + consoleErrors.join('\n'));
    }
    console.log('OK: browser-smoke.js');
  } finally {
    await browser.close();
    await stopServer(proc);
  }
}

main().catch((err) => { console.error('FEHLER in browser-smoke.js:', err); process.exit(1); });
