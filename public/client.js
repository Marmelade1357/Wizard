(function () {
  // Ermittelt automatisch, unter welchem Pfad-Präfix diese Seite gerade läuft
  // (z.B. "" bei direktem Zugriff auf diesen Server, "/wizard" wenn sie über
  // einen gemeinsamen Reverse-Proxy/Hub unter einem Unterpfad eingebunden ist).
  // Damit trifft Socket.IO immer den richtigen Endpunkt, unabhängig davon, ob
  // der Server direkt oder über den Hub erreicht wird.
  const MOUNT_PREFIX = window.location.pathname.replace(/\/[^/]*$/, '');
  const socket = io({ path: MOUNT_PREFIX + '/socket.io/' });

  // Wenn diese Seite über einen Hub (z.B. games.oualid.de) unter einem
  // Unterpfad eingebunden ist, zeigen wir einen Link zurück zur Spielauswahl
  // (Hub-Startseite). Bei direktem Zugriff ohne Hub gibt es keine Spielauswahl,
  // zu der man zurückkehren könnte - dann bleibt der Link versteckt.
  if (MOUNT_PREFIX) {
    const backHub = document.getElementById('btn-back-hub-home');
    if (backHub) {
      backHub.href = '/';
      backHub.classList.remove('hidden');
    }
  }

  const SESSION_KEY = 'wizard_session';

  let session = null; // { code, playerId, token, name }
  let latestState = null;
  let myHand = [];
  let lastTrick = null; // { round, trickNumber, cards, winnerId } - letzter abgeschlossener Stich
  let prePickedId = null; // vorab gewählte Karte (Vorauswahl-Toggle)
  let prepickOn = false;
  try { prepickOn = localStorage.getItem('wizard_prepick') === '1'; } catch (e) { /* optional */ }
  let myLegal = null; // array of legal card ids, or null wenn nicht mein Zug
  let draggingCardId = null; // Karten-ID, die gerade per Drag&Drop gezogen wird
  let prevPhase = null;
  let roundReadyClicked = false;
  let roundEndCountdownInterval = null;

  function stopRoundEndCountdown() {
    if (roundEndCountdownInterval) { clearInterval(roundEndCountdownInterval); roundEndCountdownInterval = null; }
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function show(elm) { elm.classList.remove('hidden'); }
  function hide(elm) { elm.classList.add('hidden'); }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => hide(s));
    show($(id));
    if (id === 'screen-home') releaseWakeLock(); else requestWakeLock();
  }

  // ---------------------------------------------------------------------
  // Screen Wake Lock - verhindert, dass sich das Handy während des Spiels
  // von selbst abschaltet/sperrt. Rein additiv: fehlt die API oder wird die
  // Anfrage abgelehnt (z.B. Tab im Hintergrund), passiert einfach nichts.
  // ---------------------------------------------------------------------
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* z.B. Tab nicht sichtbar oder nicht unterstützt - ignorieren */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    const homeScreen = document.getElementById('screen-home');
    const onHomeScreen = homeScreen && !homeScreen.classList.contains('hidden');
    if (document.visibilityState === 'visible' && !onHomeScreen) requestWakeLock();
  });

  // Zwei-Klick-Bestätigung, analog zum bestehenden "Bot entfernen"-Muster -
  // verhindert, dass ein Fehltipp auf "Verlassen" sofort den eigenen Platz
  // (und Punktestand) aufgibt.
  function attachConfirmClick(btn, onConfirm) {
    if (!btn) return;
    const originalText = btn.textContent;
    let confirmTimer = null;
    const reset = () => { clearTimeout(confirmTimer); confirmTimer = null; btn.classList.remove('danger'); btn.textContent = originalText; };
    btn.addEventListener('click', () => {
      if (confirmTimer) { reset(); onConfirm(); return; }
      btn.classList.add('danger');
      btn.textContent = 'Sicher?';
      confirmTimer = setTimeout(reset, 3000);
    });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(t), 3200);
  }

  function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
  function clearSession() { localStorage.removeItem(SESSION_KEY); session = null; }
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function myId() { return session ? session.playerId : null; }

  function el(tag, opts, children) {
    const e = document.createElement(tag);
    if (opts) {
      Object.entries(opts).forEach(([k, v]) => {
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      });
    }
    (children || []).forEach((c) => e.appendChild(c));
    return e;
  }

  function playerName(state, id) {
    const p = (state.players || []).find((pl) => pl.id === id);
    return p ? p.name : '?';
  }

  function suitInfo(state, suit) {
    return (state.suits || {})[suit] || { name: suit, icon: '❔', color: '#888' };
  }

  // Dateiname des gescannten Kartenbilds für eine Karte ermitteln.
  // Zauberer-/Narr-Karten haben 4 verschiedene Motive - welches gezeigt wird,
  // steht schon in der Karten-ID (z1..z4 / n1..n4), damit dieselbe Karte immer
  // gleich aussieht.
  function cardImageSrc(card) {
    if (card.kind === 'wizard') return `cards/zauberer-${card.id.slice(1)}.jpg`;
    if (card.kind === 'jester') return `cards/narr-${card.id.slice(1)}.jpg`;
    return `cards/${card.suit}-${card.value}.jpg`;
  }

  function cardLabel(card, state) {
    if (card.kind === 'wizard') return 'Zauberer';
    if (card.kind === 'jester') return 'Narr';
    return `${suitInfo(state, card.suit).name} ${card.value}`;
  }

  function renderCardEl(card, state, opts) {
    opts = opts || {};
    const extra = ['pcard'];
    if (card.kind === 'wizard') extra.push('pcard-wizard');
    if (card.kind === 'jester') extra.push('pcard-jester');
    if (opts.extraClass) extra.push(opts.extraClass);
    const img = el('img', {
      class: 'pcard-img',
      src: cardImageSrc(card),
      alt: cardLabel(card, state),
      draggable: 'false',
    });
    const div = el('div', { class: extra.join(' ') }, [img]);
    div.dataset.cardId = card.id;
    return div;
  }

  // ---------------------------------------------------------------------
  // Start screen
  // ---------------------------------------------------------------------

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => hide(p));
      show($('tab-' + btn.dataset.tab));
    });
  });

  $('btn-create').addEventListener('click', () => {
    const name = $('create-name').value.trim();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    socket.emit('createRoom', { name }, (res) => {
      if (!res.ok) return toast(res.error || 'Fehler beim Erstellen.');
      session = { code: res.code, playerId: res.playerId, token: res.token, name };
      saveSession();
    });
  });

  $('btn-join').addEventListener('click', () => {
    const name = $('join-name').value.trim();
    const code = $('join-code').value.trim().toUpperCase();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    if (!code) return toast('Bitte gib den Raum-Code ein.');
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res.ok) return toast(res.error || 'Beitritt fehlgeschlagen.');
      session = { code: res.code, playerId: res.playerId, token: res.token, name };
      saveSession();
    });
  });

  attachConfirmClick($('btn-leave-lobby'), () => {
    socket.emit('leaveRoom');
    clearSession();
    latestState = null;
    showScreen('screen-home');
  });

  attachConfirmClick($('btn-leave-game'), () => {
    socket.emit('leaveRoom');
    clearSession();
    latestState = null;
    showScreen('screen-home');
  });

  $('btn-add-bot').addEventListener('click', () => socket.emit('addBot'));
  $('btn-fill-bots').addEventListener('click', () => socket.emit('fillBots'));
  $('btn-start').addEventListener('click', () => socket.emit('startGame'));
  $('input-rounds').addEventListener('change', (e) => {
    socket.emit('setRoundsLimit', { value: e.target.value });
  });

  $('btn-show-scores').addEventListener('click', () => {
    if (latestState) renderScoresModal(latestState);
    show($('scores-modal'));
  });
  $('btn-close-scores-modal').addEventListener('click', () => hide($('scores-modal')));
  $('btn-show-lasttrick').addEventListener('click', () => {
    if (!lastTrick || !latestState) return;
    const wrap = $('lasttrick-cards');
    wrap.innerHTML = '';
    lastTrick.cards.forEach((play) => {
      wrap.appendChild(el('div', { class: 'trick-slot' + (play.playerId === lastTrick.winnerId ? ' winner' : '') }, [
        renderCardEl(play.card, latestState),
        el('span', { class: 'played-by', text: playerName(latestState, play.playerId) }),
      ]));
    });
    $('lasttrick-info').textContent = `Stich geht an ${playerName(latestState, lastTrick.winnerId)}.`;
    show($('lasttrick-modal'));
  });
  $('btn-close-lasttrick-modal').addEventListener('click', () => hide($('lasttrick-modal')));

  // ---------------------------------------------------------------------
  // Socket events
  // ---------------------------------------------------------------------

  socket.on('connect', () => {
    const saved = loadSession();
    if (saved && saved.code && saved.token) {
      session = saved;
      socket.emit('joinRoom', { code: saved.code, name: saved.name, token: saved.token }, (res) => {
        if (!res.ok) {
          clearSession();
          showScreen('screen-home');
        } else {
          session.playerId = res.playerId;
          session.token = res.token;
          saveSession();
        }
      });
    }
  });

  socket.on('yourHand', (data) => {
    myHand = data.hand || [];
    myLegal = data.legalCardIds;
    if (prePickedId && !myHand.some((c) => c.id === prePickedId)) prePickedId = null;
    if (prePickedId && myLegal) {
      // Ich bin dran: vorgewählte Karte automatisch spielen, falls erlaubt.
      const pick = prePickedId;
      prePickedId = null;
      if (myLegal.includes(pick)) {
        myLegal = null;
        socket.emit('playCard', { cardId: pick });
        return;
      }
      toast('Vorgewählte Karte ist jetzt nicht erlaubt – bitte neu wählen.');
    }
    if (latestState) render(latestState);
  });

  socket.on('gameState', (state) => {
    latestState = state;
    if (lastTrick && lastTrick.round !== state.roundNumber) lastTrick = null;
    if (state.trickResult && state.trickResult.cards && state.trickResult.cards.length) {
      lastTrick = { round: state.roundNumber, trickNumber: state.trickNumber, cards: state.trickResult.cards, winnerId: state.trickResult.winnerId };
    }
    const ltBtn = $('btn-show-lasttrick');
    if (ltBtn) ltBtn.disabled = !lastTrick;
    render(state);
  });

  // ---------------------------------------------------------------------
  // Render-Dispatcher
  // ---------------------------------------------------------------------

  function render(state) {
    if (state.phase === 'roundend' && prevPhase !== 'roundend') roundReadyClicked = false;
    if (state.phase !== 'roundend') stopRoundEndCountdown();
    prevPhase = state.phase;

    if (state.phase === 'lobby') {
      showScreen('screen-lobby');
      renderLobby(state);
      return;
    }
    showScreen('screen-game');
    renderGame(state);
  }

  // ---------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------

  function makeRemovePlayerButton(p) {
    const label = p.isBot ? 'Bot' : 'Spieler';
    const btn = el('button', { class: 'remove-bot-btn', text: '✕', title: `${label} entfernen` });
    let confirmTimer = null;
    const reset = () => { clearTimeout(confirmTimer); btn.classList.remove('confirm'); btn.textContent = '✕'; };
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.textContent = 'Sicher?';
        confirmTimer = setTimeout(reset, 3000);
        return;
      }
      reset();
      if (p.isBot) socket.emit('removeBot', { botId: p.id });
      else socket.emit('kickPlayer', { playerId: p.id });
    });
    return btn;
  }

  function renderLobby(state) {
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = state.players.length;

    const list = $('lobby-players');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const tags = [];
      if (p.isHost) tags.push(el('span', { class: 'tag host', text: 'Host' }));
      if (p.isBot) tags.push(el('span', { class: 'tag', text: '🤖 Bot' }));
      if (!p.connected && !p.isBot) tags.push(el('span', { class: 'tag', text: 'getrennt' }));
      const li = el('li', { class: !p.connected && !p.isBot ? 'disconnected' : '' }, [
        el('span', { class: 'player-name' }, [el('span', { text: p.name }), ...tags]),
      ]);
      const isHost = state.hostId === myId();
      if (isHost && p.id !== state.hostId) li.appendChild(makeRemovePlayerButton(p));
      list.appendChild(li);
    });

    const isHost = state.hostId === myId();
    const botControls = $('lobby-bot-controls');
    const fillBtn = $('btn-fill-bots');
    if (isHost) {
      show(botControls);
      if (state.players.length < state.minPlayers) show(fillBtn); else hide(fillBtn);
    } else {
      hide(botControls);
    }

    const roundsSetting = $('lobby-rounds-setting');
    const roundsDisplay = $('lobby-rounds-display');
    const roundsInput = $('input-rounds');
    const roundsMax = $('lobby-rounds-max');
    if (isHost) {
      show(roundsSetting);
      hide(roundsDisplay);
      roundsInput.max = state.maxPossibleRounds;
      if (document.activeElement !== roundsInput) roundsInput.value = state.roundsLimit;
      roundsMax.textContent = `(max. ${state.maxPossibleRounds} bei ${state.players.length} Spielern)`;
    } else {
      hide(roundsSetting);
      show(roundsDisplay);
      roundsDisplay.textContent = `Runden: ${Math.min(state.roundsLimit, state.maxPossibleRounds)}`;
    }

    const startBtn = $('btn-start');
    const statusEl = $('lobby-status');
    if (isHost) {
      const canStart = state.players.length >= state.minPlayers && state.players.length <= state.maxPlayers;
      if (canStart) {
        show(startBtn);
        statusEl.textContent = '';
      } else {
        hide(startBtn);
        statusEl.textContent = `Mindestens ${state.minPlayers} Spieler nötig (max. ${state.maxPlayers}).`;
      }
    } else {
      hide(startBtn);
      statusEl.textContent = 'Warte, bis der Host das Spiel startet …';
    }
  }

  // ---------------------------------------------------------------------
  // Spiel
  // ---------------------------------------------------------------------

  function renderGame(state) {
    $('game-code').textContent = state.code;
    $('round-badge').textContent = state.roundNumber
      ? `Runde ${state.roundNumber}/${state.maxRounds} · ${state.cardsThisRound} Karte${state.cardsThisRound === 1 ? '' : 'n'}`
      : '';

    renderTrumpBanner(state);
    renderPlayerPanel(state);
    renderHandBar(state);

    if (state.phase === 'trumpchoice') renderTrumpChoicePhase(state);
    else if (state.phase === 'bidding') renderBiddingPhase(state);
    else if (state.phase === 'playing' || state.phase === 'trickresult') renderPlayingPhase(state);
    else if (state.phase === 'roundend') renderRoundEndPhase(state);
    else if (state.phase === 'gameover') renderGameOverPhase(state);
  }

  function renderTrumpBanner(state) {
    const banner = $('trump-banner');
    banner.innerHTML = '';
    if (state.phase === 'trumpchoice') {
      banner.appendChild(el('div', { class: 'trump-banner-note', text: '🃏 Trumpfkarte ist ein Zauberer – Trumpffarbe wird noch bestimmt …' }));
      return;
    }
    if (state.trumpSuit) {
      const info = suitInfo(state, state.trumpSuit);
      const label = el('div', { class: 'trump-label', text: 'Trumpf:' });
      const value = el('div', { class: 'trump-value' }, [
        el('span', { class: 'trump-icon', text: info.icon }),
        el('span', { text: info.name }),
      ]);
      label.style.color = info.color;
      value.style.color = info.color;
      banner.appendChild(label);
      banner.appendChild(value);
    } else if (state.roundNumber) {
      banner.appendChild(el('div', { class: 'trump-banner-note', text: state.trumpCard ? '🤡 Kein Trumpf in dieser Runde (Narr aufgedeckt).' : '— Letzte Runde: kein Trumpf.' }));
    }
  }

  // Summe aller bisher abgegebenen Gebote der laufenden Runde - hilft
  // Spielern beim Vorhersagen abzuschätzen, ob insgesamt mehr oder weniger
  // Stiche getippt wurden, als es in dieser Runde überhaupt gibt.
  function renderBidTotal(state) {
    const totalEl = $('bid-total');
    if (!totalEl) return;
    const relevant = state.roundNumber
      && ['bidding', 'playing', 'trickresult', 'roundend'].includes(state.phase);
    if (!relevant) { totalEl.textContent = ''; return; }
    const bids = state.bids || {};
    const placed = state.players.map((p) => bids[p.id]).filter((v) => v !== null && v !== undefined);
    const total = placed.reduce((sum, v) => sum + v, 0);
    const allPlaced = placed.length === state.players.length;
    totalEl.textContent = allPlaced
      ? `Gesamt gewettet: ${total} von ${state.cardsThisRound} Stich${state.cardsThisRound === 1 ? '' : 'en'}`
      : `Gesamt gewettet: ${total} (noch nicht alle getippt)`;
  }

  function renderPlayerPanel(state) {
    renderBidTotal(state);
    const list = $('game-players');
    list.innerHTML = '';
    const activeId = state.phase === 'bidding' ? state.currentBidderId
      : state.phase === 'playing' ? state.currentTurnId
      : null;
    const scoreOf = (id) => (state.scores[id] != null ? state.scores[id] : 0);
    const rankOf = (id) => 1 + state.players.filter((o) => scoreOf(o.id) > scoreOf(id)).length;
    const anyScore = state.players.some((o) => scoreOf(o.id) !== 0);
    state.players.forEach((p) => {
      const tags = [];
      if (p.isHost) tags.push(el('span', { class: 'tag host', text: 'Host' }));
      if (p.isBot) tags.push(el('span', { class: 'tag', text: '🤖' }));
      if (state.dealerId === p.id) tags.push(el('span', { class: 'tag dealer', text: 'Geber' }));

      const bidVal = state.bids ? state.bids[p.id] : null;
      const tricksVal = state.tricksWon ? (state.tricksWon[p.id] || 0) : 0;
      let bidLine = '';
      if (state.roundNumber && (state.phase === 'bidding' || state.phase === 'playing' || state.phase === 'trickresult' || state.phase === 'roundend')) {
        bidLine = (bidVal === null || bidVal === undefined) ? 'Tipp: –' : `Tipp: ${bidVal} · Stiche: ${tricksVal}`;
      }

      const li = el('li', { class: [
        !p.connected && !p.isBot ? 'disconnected' : '',
        activeId === p.id ? 'active-turn' : '',
      ].filter(Boolean).join(' ') }, [
        el('div', {}, [
          el('span', { class: 'player-name' }, [el('span', { text: p.name }), ...tags]),
          bidLine ? el('div', { class: 'bid-tricks', text: bidLine }) : el('span'),
        ]),
        el('span', { class: 'score-cell' }, [
          anyScore ? el('span', { class: 'rank-badge rank-' + rankOf(p.id), title: 'Platzierung', text: rankOf(p.id) === 1 ? '🥇' : `${rankOf(p.id)}.` }) : el('span'),
          el('span', { class: 'score-value', text: String(scoreOf(p.id)) }),
        ]),
      ]);
      list.appendChild(li);
    });
  }

  const prepickBox = $('toggle-prepick');
  if (prepickBox) {
    prepickBox.checked = prepickOn;
    prepickBox.addEventListener('change', () => {
      prepickOn = prepickBox.checked;
      if (!prepickOn) prePickedId = null;
      try { localStorage.setItem('wizard_prepick', prepickOn ? '1' : '0'); } catch (e) { /* optional */ }
      if (latestState) renderHandBar(latestState);
    });
  }

  // Ermittelt die Farbe, die im laufenden Stich bedient werden muss - spiegelt
  // exakt die serverseitige ledSuitOfTrick() aus server.js. undefined = noch
  // offen (bisher nur Narren gespielt), null = für immer offen (ein Zauberer
  // wurde gespielt, bevor eine Farbe feststand).
  function ledSuitOfTrick(trick) {
    for (const play of trick) {
      if (play.card.kind === 'suit') return play.card.suit;
      if (play.card.kind === 'wizard') return null;
    }
    return undefined;
  }

  // Welche Karten der eigenen Hand wären JETZT, im aktuell laufenden Stich,
  // wirklich erlaubt? Spiegelt legalCardsFor() aus server.js clientseitig,
  // weil der Server legalCardIds nur schickt, wenn man tatsächlich am Zug
  // ist - für die Vorauswahl (vor dem eigenen Zug) gibt es diese Daten sonst
  // nicht. Nutzt ausschließlich bereits öffentliche Daten (state.currentTrick
  // + eigene Hand), keine Serveranfrage nötig.
  function currentlyLegalCardIds(state) {
    const led = ledSuitOfTrick(state.currentTrick || []);
    if (led === null || led === undefined) return myHand.map((c) => c.id);
    const hasLed = myHand.some((c) => c.kind === 'suit' && c.suit === led);
    if (!hasLed) return myHand.map((c) => c.id);
    return myHand
      .filter((c) => (c.kind === 'suit' && c.suit === led) || c.kind === 'wizard' || c.kind === 'jester')
      .map((c) => c.id);
  }

  function renderHandBar(state) {
    const bar = $('hand-bar');
    const showBar = ['trumpchoice', 'bidding', 'playing', 'trickresult'].includes(state.phase) && myHand.length > 0;
    if (!showBar) { hide(bar); return; }
    show(bar);
    const list = $('hand-list');
    list.innerHTML = '';
    const canPlay = state.phase === 'playing' && state.currentTurnId === myId();
    // Vorauswahl ist nur während der aktiven Stichphase sinnvoll einschränkbar:
    // im trickresult zeigt state.currentTrick noch den GERADE ABGESCHLOSSENEN
    // Stich (wird erst nach TRICK_RESULT_DELAY_MS geleert), das würde also die
    // Legalität für den NÄCHSTEN Stich falsch berechnen. Dort bleibt der
    // Vorauswahl-Klick daher deaktiviert.
    const prepickEligiblePhase = prepickOn && !canPlay && state.phase === 'playing';
    const legalPrepickIds = prepickEligiblePhase ? currentlyLegalCardIds(state) : [];
    // Wurde die vorgewählte Karte inzwischen (weil andere Spieler die Farbe im
    // Stich vorgegeben haben) illegal, verwerfen wir die Vorauswahl wieder -
    // sie müsste sonst neu bestätigt werden.
    if (prePickedId && prepickEligiblePhase && !legalPrepickIds.includes(prePickedId)) {
      prePickedId = null;
    }
    myHand.forEach((card) => {
      const isLegal = canPlay && myLegal && myLegal.includes(card.id);
      const canPrepick = prepickEligiblePhase && legalPrepickIds.includes(card.id);
      // "disabled" (abgedunkelt/entsättigt) gibt es NUR, wenn gerade wirklich
      // eine Auswahl mit Einschränkung angezeigt wird (eigener Zug, oder
      // aktive Vorauswahl) - nicht einfach nur, weil man wartet und die
      // Vorauswahl aus ist. Sonst wäre die eigene Hand die ganze Zeit, in der
      // man auf seinen Zug wartet, kaum lesbar - das war der eigentliche
      // Sinn der Vorauswahl-Karten-Leiste (die eigene Hand jederzeit sehen).
      let cls;
      if (canPlay) cls = isLegal ? '' : 'disabled';
      else if (prepickEligiblePhase) cls = canPrepick ? 'prepickable' : 'disabled';
      else cls = '';
      const cardEl = renderCardEl(card, state, { extraClass: cls + (canPrepick && prePickedId === card.id ? ' prepicked' : '') });
      if (canPrepick) {
        cardEl.addEventListener('click', () => {
          prePickedId = prePickedId === card.id ? null : card.id;
          if (latestState) renderHandBar(latestState);
        });
      }
      if (isLegal) {
        const playThisCard = () => {
          myLegal = null;
          socket.emit('playCard', { cardId: card.id });
        };
        // Klick zum Spielen (funktioniert überall, auch am Handy) ...
        cardEl.addEventListener('click', playThisCard);
        // ... und zusätzlich per Maus auf den Tisch ziehen und dort ablegen.
        cardEl.draggable = true;
        cardEl.addEventListener('dragstart', (e) => {
          draggingCardId = card.id;
          cardEl.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', card.id); } catch (err) { /* Safari-Eigenheit, ignorierbar */ }
        });
        cardEl.addEventListener('dragend', () => {
          draggingCardId = null;
          cardEl.classList.remove('dragging');
        });
      }
      list.appendChild(cardEl);
    });
  }

  function setPhase(title, contentNodes) {
    $('phase-title').textContent = title;
    const content = $('phase-content');
    content.innerHTML = '';
    (contentNodes || []).forEach((n) => content.appendChild(n));
  }

  function renderTrumpChoicePhase(state) {
    if (state.trumpChoiceById === myId()) {
      const suitKeys = Object.keys(state.suits || {});
      const btns = suitKeys.map((s) => {
        const info = state.suits[s];
        const b = el('button', { class: 'suit-btn' }, [
          document.createTextNode(info.icon),
          el('small', { text: info.name }),
        ]);
        b.style.borderColor = info.color;
        b.style.color = info.color;
        b.addEventListener('click', () => socket.emit('chooseTrump', { suit: s }));
        return b;
      });
      setPhase('Du bist Kartengeber: wähle die Trumpffarbe', [el('div', { class: 'suit-choice' }, btns)]);
    } else {
      setPhase('Trumpffarbe wird bestimmt', [
        el('p', { class: 'waiting-note', text: `${playerName(state, state.trumpChoiceById)} bestimmt gerade die Trumpffarbe …` }),
      ]);
    }
  }

  function renderBiddingPhase(state) {
    const nodes = [];
    const submitted = state.bidOrder.filter((id) => state.bids[id] !== null && state.bids[id] !== undefined);
    const mine = state.currentBidderId === myId();
    const bidsList = () => el('ul', { class: 'bids-so-far' + (mine ? ' highlight' : '') }, submitted.map((id) => el('li', {}, [
      el('span', { text: playerName(state, id) }),
      el('span', { class: 'bid-chip', text: String(state.bids[id]) }),
    ])));
    if (mine) {
      // Die Tipps vor mir stehen bewusst GANZ OBEN und sind hervorgehoben -
      // genau sie braucht man für die eigene Vorhersage.
      const sum = submitted.reduce((a, id) => a + state.bids[id], 0);
      if (submitted.length) {
        nodes.push(el('p', { class: 'bids-before-title', text: `Tipps vor dir: zusammen ${sum} von ${state.cardsThisRound} Stich${state.cardsThisRound === 1 ? '' : 'en'}` }));
        nodes.push(bidsList());
      }
      const btns = [];
      for (let i = 0; i <= state.cardsThisRound; i++) {
        const b = el('button', { class: 'bid-btn', text: String(i) });
        b.addEventListener('click', () => socket.emit('placeBid', { value: i }));
        btns.push(b);
      }
      nodes.push(el('p', {}, [document.createTextNode('Wie viele Stiche machst du diese Runde?')]));
      nodes.push(el('div', { class: 'bid-choice' }, btns));
    } else {
      nodes.push(el('p', { class: 'waiting-note', text: `${playerName(state, state.currentBidderId)} sagt gerade vorher …` }));
      if (submitted.length) nodes.push(bidsList());
    }
    setPhase('Vorhersage', nodes);
  }

  function renderPlayingPhase(state) {
    const myTurnToPlay = state.phase === 'playing' && state.currentTurnId === myId();

    // Der "Tisch": die Fläche, auf der die ausgespielten Karten des aktuellen
    // Stichs liegen. Wenn man am Zug ist, kann man eine Karte aus der Hand
    // auch hierher ziehen und ablegen, statt sie nur anzutippen.
    const trickArea = el('div', { class: 'trick-area' });
    (state.currentTrick || []).forEach((play) => {
      const isWinner = state.trickResult && state.trickResult.winnerId === play.playerId;
      const slot = el('div', { class: 'trick-slot' + (isWinner ? ' winner' : '') }, [
        renderCardEl(play.card, state),
        el('span', { class: 'played-by', text: playerName(state, play.playerId) }),
      ]);
      trickArea.appendChild(slot);
    });

    if (myTurnToPlay && (state.currentTrick || []).length === 0) {
      trickArea.appendChild(el('div', { class: 'trick-area-hint', text: 'Ziehe deine Karte hierher …' }));
    }

    if (myTurnToPlay) {
      trickArea.classList.add('is-dropzone');
      trickArea.addEventListener('dragover', (e) => {
        if (!draggingCardId || !myLegal || !myLegal.includes(draggingCardId)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        trickArea.classList.add('drop-target');
      });
      trickArea.addEventListener('dragleave', () => trickArea.classList.remove('drop-target'));
      trickArea.addEventListener('drop', (e) => {
        e.preventDefault();
        trickArea.classList.remove('drop-target');
        const cardId = draggingCardId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
        if (cardId && myLegal && myLegal.includes(cardId)) {
          myLegal = null;
          socket.emit('playCard', { cardId });
        }
      });
    }

    const nodes = [trickArea];
    if (state.phase === 'trickresult' && state.trickResult) {
      nodes.push(el('p', { class: 'waiting-note', text: `${playerName(state, state.trickResult.winnerId)} gewinnt den Stich!` }));
    } else if (myTurnToPlay) {
      nodes.push(el('p', {}, [document.createTextNode('Du bist am Zug – ziehe eine Karte auf den Tisch oder tippe sie unten an.')]));
    } else {
      nodes.push(el('p', { class: 'waiting-note', text: `${playerName(state, state.currentTurnId)} ist am Zug …` }));
    }
    setPhase(`Stich ${state.trickNumber}/${state.cardsThisRound}`, nodes);
  }

  function buildRoundRow(state, round) {
    return state.players.map((p) => {
      const e = round.entries[p.id];
      if (!e) return el('td', { text: '–' });
      const cls = e.points > 0 ? 'points-pos' : (e.points < 0 ? 'points-neg' : '');
      return el('td', {}, [
        el('div', { text: `Tipp ${e.bid} · Stiche ${e.tricks}` }),
        el('div', { class: cls, text: `${e.points > 0 ? '+' : ''}${e.points} → ${e.total}` }),
      ]);
    });
  }

  function renderRoundEndPhase(state) {
    const lastRound = state.history[state.history.length - 1];
    const nodes = [];
    if (lastRound) {
      const table = el('table', { class: 'round-result-table' }, [
        el('thead', {}, [el('tr', {}, state.players.map((p) => el('th', { text: p.name })))]),
        el('tbody', {}, [el('tr', {}, buildRoundRow(state, lastRound))]),
      ]);
      nodes.push(table);
    }
    const iAmReady = (state.roundReady || []).includes(myId());
    if (iAmReady) {
      nodes.push(el('p', { class: 'waiting-note', text: 'Warte auf die anderen Zauberlehrlinge …' }));
    } else {
      const btn = el('button', { class: 'btn primary', text: state.roundNumber >= state.maxRounds ? 'Endauswertung ansehen' : 'Bereit für die nächste Runde' });
      btn.addEventListener('click', () => { socket.emit('readyNextRound'); });
      nodes.push(btn);
    }
    if (state.roundEndDeadline) {
      nodes.push(el('p', { id: 'round-end-countdown', class: 'hint round-end-countdown' }));
    }
    setPhase(`Runde ${lastRound ? lastRound.round : state.roundNumber} ausgewertet`, nodes);

    stopRoundEndCountdown();
    if (state.roundEndDeadline) {
      const deadline = state.roundEndDeadline;
      const update = () => {
        const node = $('round-end-countdown');
        if (!node) { stopRoundEndCountdown(); return; }
        const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        node.textContent = `Weiter in ${secs}s, falls nicht alle bereit sind …`;
      };
      update();
      roundEndCountdownInterval = setInterval(update, 500);
    }
  }

  function renderGameOverPhase(state) {
    const winners = (state.winnerIds || []).map((id) => playerName(state, id));
    const nodes = [];
    nodes.push(el('div', { class: 'winner-banner' }, [
      el('div', { class: 'crown', text: '🏆' }),
      el('h2', { text: winners.length > 1 ? `Geteilter Sieg: ${winners.join(', ')}` : `${winners[0] || '?'} gewinnt!` }),
    ]));

    const sorted = state.players.slice().sort((a, b) => (state.scores[b.id] || 0) - (state.scores[a.id] || 0));
    const table = el('table', { class: 'scores-table' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: 'Zauberlehrling' }), el('th', { text: 'Punkte' })])]),
      el('tbody', {}, sorted.map((p) => el('tr', {}, [
        el('td', { text: p.name }),
        el('td', { text: String(state.scores[p.id] || 0) }),
      ]))),
    ]);
    nodes.push(table);

    if (state.hostId === myId()) {
      const btn = el('button', { class: 'btn primary', text: 'Neue Partie (zurück zur Lobby)' });
      btn.addEventListener('click', () => socket.emit('resetGame'));
      nodes.push(btn);
    } else {
      nodes.push(el('p', { class: 'waiting-note', text: `Warte auf ${playerName(state, state.hostId)} für eine neue Partie …` }));
    }
    setPhase('Spiel beendet', nodes);
  }

  function renderScoresModal(state) {
    const wrap = $('scores-table-wrap');
    wrap.innerHTML = '';
    if (!state.history || !state.history.length) {
      wrap.appendChild(el('p', { class: 'waiting-note', text: 'Noch keine Runde beendet.' }));
      return;
    }
    const table = el('table', { class: 'scores-table' });
    const thead = el('thead', {}, [el('tr', {}, [el('th', { class: 'round-col', text: 'Runde' }), ...state.players.map((p) => el('th', { text: p.name }))])]);
    const tbody = el('tbody', {}, state.history.map((round) => el('tr', {}, [
      el('td', { class: 'round-col', text: String(round.round) }),
      ...buildRoundRow(state, round),
    ])));
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ---------------------------------------------------------------------
  // Komfort: gemerkter Name, Enter-Taste, Einladungslink, Warte-Hinweis,
  // Barrierefreiheits-Attribute
  // ---------------------------------------------------------------------
  (function comfort() {
    const NAME_KEY = 'spiele_name';
    const SKIP_AFTER_MS = 20000;
    const q = (id) => document.getElementById(id);
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* optional */ } };

    // --- Name merken ---
    const cn = q('create-name'); const jn = q('join-name'); const jc = q('join-code');
    const cached = lsGet(NAME_KEY);
    [cn, jn].forEach((inp) => {
      if (!inp) return;
      if (cached && !inp.value) inp.value = cached;
      inp.addEventListener('input', () => { const v = inp.value.trim(); if (v) { lsSet(NAME_KEY, v); [cn, jn].forEach((o) => { if (o && o !== inp) o.value = inp.value; }); } });
      inp.setAttribute('autocomplete', 'nickname');
      inp.setAttribute('autocapitalize', 'words');
      inp.setAttribute('aria-label', 'Dein Name');
      inp.setAttribute('enterkeyhint', 'go');
    });
    if (jc) {
      jc.setAttribute('autocomplete', 'off'); jc.setAttribute('autocapitalize', 'characters');
      jc.setAttribute('autocorrect', 'off'); jc.setAttribute('spellcheck', 'false');
      jc.setAttribute('aria-label', 'Raum-Code'); jc.setAttribute('enterkeyhint', 'go');
      jc.addEventListener('input', () => { jc.value = jc.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    }

    // --- Enter sendet ab ---
    if (cn) cn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q('btn-create').click(); } });
    if (jn) jn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (jc && !jc.value.trim()) jc.focus(); else q('btn-join').click();
    });
    if (jc) jc.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q('btn-join').click(); } });

    // --- Beitritt per Link (?code=AB12) ---
    try {
      const urlCode = (new URLSearchParams(window.location.search).get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (urlCode && jc) {
        try {
          const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
          if (s && s.code !== urlCode) localStorage.removeItem(SESSION_KEY);
        } catch (e) { /* ignore */ }
        jc.value = urlCode;
        const tabBtn = document.querySelector('.tab-btn[data-tab="join"]');
        if (tabBtn) tabBtn.click();
        const target = (jn && !jn.value.trim()) ? jn : q('btn-join');
        if (target) setTimeout(() => target.focus(), 50);
      }
    } catch (e) { /* ignore */ }

    // --- Einladungslink kopieren ---
    async function copyText(text) {
      try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* Fallback unten */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
      } catch (e) { return false; }
    }
    const share = q('btn-share-link');
    if (share) {
      share.addEventListener('click', async () => {
        const code = (q('lobby-code').textContent || '').trim();
        if (!/^[A-Z0-9]{4}$/.test(code)) return;
        const url = window.location.origin + window.location.pathname + '?code=' + code;
        if (await copyText(url)) toast('Link kopiert – jetzt einfach verschicken.');
        else window.prompt('Link zum Kopieren:', url);
      });
    }

    // --- Warte-Hinweis + "Überspringen" ---
    const gameScreen = q('screen-game');
    let banner = null; let bText = null; let bBtn = null;
    let waiting = null; let recvAt = 0; let lastState = null;
    if (gameScreen) {
      banner = document.createElement('div');
      banner.id = 'wait-banner'; banner.className = 'wait-banner hidden';
      banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite');
      bText = document.createElement('span'); bText.id = 'wait-text';
      bBtn = document.createElement('button'); bBtn.id = 'btn-skip-turn'; bBtn.type = 'button';
      bBtn.className = 'btn secondary small hidden'; bBtn.textContent = '⏭ Überspringen';
      bBtn.addEventListener('click', () => { socket.emit('skipTurn'); bBtn.classList.add('hidden'); });
      banner.appendChild(bText); banner.appendChild(bBtn);
      const header = gameScreen.querySelector('header');
      if (header) header.after(banner); else gameScreen.prepend(banner);
    }
    function paintWait() {
      if (!banner) return;
      if (!waiting || !lastState || !waiting.ids.length || waiting.ids.includes(myId())) { banner.classList.add('hidden'); return; }
      const sec = Math.floor((waiting.elapsedMs + (Date.now() - recvAt)) / 1000);
      if (sec < 8) { banner.classList.add('hidden'); return; }
      const names = waiting.ids.map((id) => { const p = (lastState.players || []).find((pl) => pl.id === id); return p ? p.name : '?'; }).join(', ');
      bText.textContent = `⏳ ${names} – wartet seit ${sec} s`;
      banner.classList.remove('hidden');
      const canSkip = sec * 1000 >= SKIP_AFTER_MS && (lastState.hostId === myId() || waiting.ids.includes(lastState.hostId));
      bBtn.classList.toggle('hidden', !canSkip);
    }
    socket.on('gameState', (state) => {
      lastState = state;
      const w = state.waiting || null;
      if (w) { waiting = w; recvAt = Date.now(); } else { waiting = null; }
      paintWait();
    });
    setInterval(paintWait, 1000);

    // --- Barrierefreiheit ---
    const toastEl = q('toast');
    if (toastEl) { toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite'); }
    document.querySelectorAll('.modal').forEach((m) => {
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
      const h = m.querySelector('h2'); if (h) m.setAttribute('aria-label', h.textContent.trim());
    });
    document.querySelectorAll('.modal-close').forEach((b) => b.setAttribute('aria-label', 'Schließen'));
    const tabs = document.querySelector('.tabs');
    if (tabs) {
      tabs.setAttribute('role', 'tablist');
      const syncTabs = () => tabs.querySelectorAll('.tab-btn').forEach((b) => b.setAttribute('aria-selected', b.classList.contains('active') ? 'true' : 'false'));
      tabs.querySelectorAll('.tab-btn').forEach((b) => b.setAttribute('role', 'tab'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.setAttribute('role', 'tabpanel'));
      new MutationObserver(syncTabs).observe(tabs, { subtree: true, attributes: true, attributeFilter: ['class'] });
      syncTabs();
    }
    const labelIf = (id, txt) => { const e = q(id); if (e && !e.getAttribute('aria-label')) e.setAttribute('aria-label', txt); };
    labelIf('btn-toggle-sound', 'Ton an oder aus'); labelIf('btn-sound', 'Ton an oder aus'); labelIf('btn-mute', 'Ton an oder aus');
    labelIf('btn-leave-lobby', 'Raum verlassen'); labelIf('btn-leave-game', 'Spiel verlassen');
    const lc = q('lobby-code'); if (lc) lc.setAttribute('aria-label', 'Raum-Code');
  })();

  // Regeln-Dialog
  (function rules() {
    const m = document.getElementById('rules-modal');
    if (!m) return;
    ['btn-show-rules', 'btn-show-rules-lobby'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', () => m.classList.remove('hidden'));
    });
    document.getElementById('btn-close-rules-modal').addEventListener('click', () => m.classList.add('hidden'));
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
  })();
})();
