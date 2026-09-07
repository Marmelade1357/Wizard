(function () {
  // Ermittelt automatisch, unter welchem Pfad-Präfix diese Seite gerade läuft
  // (z.B. "" bei direktem Zugriff auf diesen Server, "/wizard" wenn sie über
  // einen gemeinsamen Reverse-Proxy/Hub unter einem Unterpfad eingebunden ist).
  // Damit trifft Socket.IO immer den richtigen Endpunkt, unabhängig davon, ob
  // der Server direkt oder über den Hub erreicht wird.
  const MOUNT_PREFIX = window.location.pathname.replace(/\/[^/]*$/, '');
  const socket = io({ path: MOUNT_PREFIX + '/socket.io/' });

  const SESSION_KEY = 'wizard_session';

  let session = null; // { code, playerId, token, name }
  let latestState = null;
  let myHand = [];
  let myLegal = null; // array of legal card ids, or null wenn nicht mein Zug
  let prevPhase = null;
  let roundReadyClicked = false;

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function show(elm) { elm.classList.remove('hidden'); }
  function hide(elm) { elm.classList.add('hidden'); }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => hide(s));
    show($(id));
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

  function renderCardEl(card, state, opts) {
    opts = opts || {};
    if (card.kind === 'wizard') {
      return el('div', { class: 'pcard pcard-wizard' + (opts.extraClass ? ' ' + opts.extraClass : '') }, [
        el('span', { class: 'pcard-icon', text: '🧙' }),
        el('span', { class: 'pcard-value', text: 'Zauberer' }),
      ]);
    }
    if (card.kind === 'jester') {
      return el('div', { class: 'pcard pcard-jester' + (opts.extraClass ? ' ' + opts.extraClass : '') }, [
        el('span', { class: 'pcard-icon', text: '🤡' }),
        el('span', { class: 'pcard-value', text: 'Narr' }),
      ]);
    }
    const info = suitInfo(state, card.suit);
    const div = el('div', { class: 'pcard' + (opts.extraClass ? ' ' + opts.extraClass : '') }, [
      el('span', { class: 'pcard-icon', text: info.icon }),
      el('span', { class: 'pcard-value', text: String(card.value) }),
    ]);
    div.style.borderColor = info.color;
    div.style.color = info.color;
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

  $('btn-leave-lobby').addEventListener('click', () => {
    socket.emit('leaveRoom');
    clearSession();
    latestState = null;
    showScreen('screen-home');
  });

  $('btn-leave-game').addEventListener('click', () => {
    socket.emit('leaveRoom');
    clearSession();
    latestState = null;
    showScreen('screen-home');
  });

  $('btn-add-bot').addEventListener('click', () => socket.emit('addBot'));
  $('btn-fill-bots').addEventListener('click', () => socket.emit('fillBots'));
  $('btn-start').addEventListener('click', () => socket.emit('startGame'));

  $('btn-show-scores').addEventListener('click', () => {
    if (latestState) renderScoresModal(latestState);
    show($('scores-modal'));
  });
  $('btn-close-scores-modal').addEventListener('click', () => hide($('scores-modal')));

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
    if (latestState) render(latestState);
  });

  socket.on('gameState', (state) => {
    latestState = state;
    render(state);
  });

  // ---------------------------------------------------------------------
  // Render-Dispatcher
  // ---------------------------------------------------------------------

  function render(state) {
    if (state.phase === 'roundend' && prevPhase !== 'roundend') roundReadyClicked = false;
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
      banner.appendChild(el('span', { text: '🃏 Trumpfkarte ist ein Zauberer – Trumpffarbe wird noch bestimmt …' }));
      return;
    }
    if (state.trumpSuit) {
      const info = suitInfo(state, state.trumpSuit);
      const span = el('span', {}, [
        el('span', { text: 'Trumpf: ' }),
        el('strong', { text: `${info.icon} ${info.name}` }),
      ]);
      span.style.color = info.color;
      banner.appendChild(span);
    } else if (state.roundNumber) {
      banner.appendChild(el('span', { text: state.trumpCard ? '🤡 Kein Trumpf in dieser Runde (Narr aufgedeckt).' : '— Letzte Runde: kein Trumpf.' }));
    }
  }

  function renderPlayerPanel(state) {
    const list = $('game-players');
    list.innerHTML = '';
    const activeId = state.phase === 'bidding' ? state.currentBidderId
      : state.phase === 'playing' ? state.currentTurnId
      : null;
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
        el('span', { class: 'score-value', text: String(state.scores[p.id] != null ? state.scores[p.id] : 0) }),
      ]);
      list.appendChild(li);
    });
  }

  function renderHandBar(state) {
    const bar = $('hand-bar');
    const showBar = ['trumpchoice', 'bidding', 'playing', 'trickresult'].includes(state.phase) && myHand.length > 0;
    if (!showBar) { hide(bar); return; }
    show(bar);
    const list = $('hand-list');
    list.innerHTML = '';
    const canPlay = state.phase === 'playing' && state.currentTurnId === myId();
    myHand.forEach((card) => {
      const isLegal = canPlay && myLegal && myLegal.includes(card.id);
      const cardEl = renderCardEl(card, state, { extraClass: canPlay ? (isLegal ? '' : 'disabled') : 'disabled' });
      if (isLegal) {
        cardEl.addEventListener('click', () => {
          myLegal = null;
          socket.emit('playCard', { cardId: card.id });
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
    if (state.currentBidderId === myId()) {
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
    }

    const submitted = state.bidOrder.filter((id) => state.bids[id] !== null && state.bids[id] !== undefined);
    if (submitted.length) {
      const ul = el('ul', { class: 'bids-so-far' }, submitted.map((id) => el('li', {}, [
        el('span', { text: playerName(state, id) }),
        el('span', { text: String(state.bids[id]) }),
      ])));
      nodes.push(ul);
    }
    setPhase('Vorhersage', nodes);
  }

  function renderPlayingPhase(state) {
    const trickArea = el('div', { class: 'trick-area' });
    (state.currentTrick || []).forEach((play) => {
      const isWinner = state.trickResult && state.trickResult.winnerId === play.playerId;
      const slot = el('div', { class: 'trick-slot' + (isWinner ? ' winner' : '') }, [
        renderCardEl(play.card, state),
        el('span', { class: 'played-by', text: playerName(state, play.playerId) }),
      ]);
      trickArea.appendChild(slot);
    });

    const nodes = [trickArea];
    if (state.phase === 'trickresult' && state.trickResult) {
      nodes.push(el('p', { class: 'waiting-note', text: `${playerName(state, state.trickResult.winnerId)} gewinnt den Stich!` }));
    } else if (state.currentTurnId === myId()) {
      nodes.push(el('p', {}, [document.createTextNode('Du bist am Zug – wähle unten eine Karte.')]));
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
    setPhase(`Runde ${lastRound ? lastRound.round : state.roundNumber} ausgewertet`, nodes);
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
})();
