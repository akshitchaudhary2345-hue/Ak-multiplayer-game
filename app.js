import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getDatabase, ref, set, update, push, onValue, onChildAdded, onDisconnect,
  runTransaction, get
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAgPD5jPffjsD1vYH8zlYGKcpgsDPNtgHw",
  authDomain: "ak-multiplayer-game.firebaseapp.com",
  databaseURL: "https://ak-multiplayer-game-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ak-multiplayer-game",
  storageBucket: "ak-multiplayer-game.firebasestorage.app",
  messagingSenderId: "398552533347",
  appId: "1:398552533347:web:d75607e3a0a81e7f8eeb56"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const $ = id => document.getElementById(id);

const uid = globalThis.crypto?.randomUUID
  ? crypto.randomUUID()
  : "p_" + Date.now() + "_" + Math.random().toString(36).slice(2);

let roomCode = "";
let myName = "";
let isHost = false;
let state = null;
let pending = null;
let bound = false;
let botTimer = null;
let lastBotAction = "";

const COLORS = ["red", "yellow", "green", "blue"];

const CUSTOM_NAMES = {
  swap: "SWAP",
  discardAllWild: "DISCARD WILD",
  exactSeven: "EXACT 7",
  colorPunishment: "COLOUR +3"
};

function room(path = "") {
  return ref(db, `rooms/${roomCode}${path ? `/${path}` : ""}`);
}

function text(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c]));
}

function message(value) {
  const el = $("toast");
  if (!el) return;

  el.textContent = value;
  el.classList.add("show");

  setTimeout(() => el.classList.remove("show"), 2400);
}

function screen(id) {
  document.querySelectorAll(".view")
    .forEach(view => view.classList.remove("active"));

  $(id)?.classList.add("active");
}

function newRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function makeCard(id, color, value, type = "number") {
  return { id, color, value, type };
}

function shuffle(cards) {
  const result = [...cards];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function createDeck() {
  const deck = [];
  let id = 0;

  for (const color of COLORS) {
    deck.push(makeCard(`card${id++}`, color, 0));

    for (let number = 1; number <= 9; number++) {
      deck.push(makeCard(`card${id++}`, color, number));
      deck.push(makeCard(`card${id++}`, color, number));
    }

    for (const action of ["skip", "reverse", "draw2"]) {
      deck.push(makeCard(`card${id++}`, color, action, "action"));
      deck.push(makeCard(`card${id++}`, color, action, "action"));
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push(makeCard(`card${id++}`, null, "wild", "wild"));
    deck.push(makeCard(`card${id++}`, null, "draw4", "wildDraw4"));
  }

  for (let i = 0; i < 2; i++) {
    deck.push(makeCard(`card${id++}`, null, "swap", "custom"));
    deck.push(makeCard(`card${id++}`, null, "discardAllWild", "custom"));
    deck.push(makeCard(`card${id++}`, null, "exactSeven", "custom"));
    deck.push(makeCard(`card${id++}`, null, "colorPunishment", "custom"));
  }

  return deck;
}

function players() {
  return state?.players || {};
}

function topCard() {
  const cards = state?.discard || [];
  return cards[cards.length - 1] || null;
}

function isMyTurn() {
  return state?.currentPlayer === uid;
}

function playerIds(playerMap = players()) {
  return Object.keys(playerMap || {});
}

function nextPlayer(
  id,
  steps = 1,
  direction = state?.direction || 1,
  ids = playerIds()
) {
  if (!ids.length) return id;

  let index = ids.indexOf(id);
  if (index < 0) index = 0;

  index = ((index + direction * steps) % ids.length + ids.length) % ids.length;

  return ids[index];
}

function displayCard(card) {
  if (!card) return "";

  if (card.type === "custom") {
    return CUSTOM_NAMES[card.value] || card.value;
  }

  return ({
    skip: "SKIP",
    reverse: "REV",
    draw2: "+2",
    draw4: "+4",
    wild: "WILD"
  })[card.value] ?? String(card.value);
}

function cardClass(card) {
  if (["wild", "wildDraw4", "custom"].includes(card.type)) {
    return "wild";
  }

  return card.color || "wild";
}

function cardHtml(card) {
  return `<div class="play-card ${cardClass(card)}">${text(displayCard(card))}</div>`;
}

function isColourOnlyWild(card) {
  return card?.type === "wild" && card?.value === "wild";
}

function hasCurrentColour(hand) {
  return hand.some(card =>
    card.color === state?.currentColor &&
    card.type !== "wild" &&
    card.type !== "wildDraw4" &&
    card.type !== "custom"
  );
}

function playable(card, game = state) {
  const top = game?.discard?.[game.discard.length - 1];

  if (!top) return false;

  if ((game.pendingDraw || 0) > 0) {
    if (game.pendingType === "draw2") return card.value === "draw2";
    if (game.pendingType === "draw4") return card.value === "draw4";
  }

  if (["wild", "wildDraw4", "custom"].includes(card.type)) {
    return true;
  }

  return card.color === game.currentColor || card.value === top.value;
}

function initialGame(allPlayers) {
  let deck = shuffle(createDeck());
  const hands = {};
  const ids = Object.keys(allPlayers);

  ids.forEach(id => {
    hands[id] = deck.splice(0, 7);
  });

  let first = deck.shift();

  while (
    first &&
    (
      first.type === "wildDraw4" ||
      first.type === "custom" ||
      first.type === "wild"
    )
  ) {
    deck.push(first);
    first = deck.shift();
  }

  return {
    status: "game",
    players: allPlayers,
    deck,
    discard: [first],
    hands,
    currentPlayer: ids[0],
    direction: 1,
    currentColor: first?.color || "red",
    pendingDraw: 0,
    pendingType: null,
    lastAction: `${allPlayers[ids[0]]?.name || "Player"} started`,
    winner: null,
    hammerUsed: {},
    revision: 1,
    hostId: uid
  };
}
async function createRoom() {
  const name = $("playerName")?.value.trim();

  if (!name) {
    message("Enter your name first!");
    return;
  }

  myName = name;
  isHost = true;

  let code;
  let exists = true;

  while (exists) {
    code = newRoomCode();
    const snapshot = await get(ref(db, `rooms/${code}`));
    exists = snapshot.exists();
  }

  roomCode = code;

  const player = {
    name: myName,
    isBot: false,
    connected: true,
    unoCalled: false,
    joinedAt: Date.now()
  };

  await set(room(), {
    status: "lobby",
    hostId: uid,
    players: { [uid]: player },
    createdAt: Date.now(),
    chat: {}
  });

  await onDisconnect(room(`players/${uid}/connected`)).set(false);

  enterLobby();
  bindRoom();
}

async function joinRoom() {
  const name = $("playerName")?.value.trim();
  const code = $("roomCode")?.value.trim().toUpperCase();

  if (!name || !code) {
    message("Enter your name and room code!");
    return;
  }

  const snapshot = await get(ref(db, `rooms/${code}`));

  if (!snapshot.exists()) {
    message("Room not found!");
    return;
  }

  const data = snapshot.val();

  if (data.status !== "lobby") {
    message("Game has already started!");
    return;
  }

  const count = Object.keys(data.players || {}).length;

  if (count >= 10) {
    message("Room is full!");
    return;
  }

  roomCode = code;
  myName = name;
  isHost = data.hostId === uid;

  await update(room(`players/${uid}`), {
    name: myName,
    isBot: false,
    connected: true,
    unoCalled: false,
    joinedAt: Date.now()
  });

  await onDisconnect(room(`players/${uid}/connected`)).set(false);

  enterLobby();
  bindRoom();
}

function enterLobby() {
  screen("lobbyveiw");

  if ($("lobbyRoomCode")) {
    $("lobbyRoomCode").textContent = roomCode;
  }

  if ($("roomCodeDisplay")) {
    $("roomCodeDisplay").textContent = roomCode;
  }

  if ($("playerDisplayName")) {
    $("playerDisplayName").textContent = myName;
  }

  if ($("hostControls")) {
    $("hostControls").style.display = isHost ? "" : "none";
  }
}

function bindRoom() {
  onValue(room(), snapshot => {
    if (!snapshot.exists()) {
      message("Room has been closed.");
      return;
    }

    state = snapshot.val();

    if (state.status === "lobby") {
      renderLobby();
      screen("lobbyScreen");
    } else if (state.status === "game") {
      screen("gameveiw");
      renderGame();
      runBotTurn();
    } else if (state.status === "finished") {
      renderGame();
      message(
        `${state.players?.[state.winner]?.name || "Player"} wins!`
      );
    }
  });

  onChildAdded(room("chat"), snapshot => {
    const data = snapshot.val();
    if (data) renderChatMessage(data);
  });
}

function renderLobby() {
  const list = $("lobbyPlayers");
  if (!list) return;

  list.innerHTML = "";

  Object.entries(players()).forEach(([id, player]) => {
    const item = document.createElement("div");
    item.className = "lobby-player";

    item.innerHTML = `
      <span>${text(player.name)}</span>
      ${id === state.hostId ? "<small>HOST</small>" : ""}
      ${player.isBot ? "<small>BOT</small>" : ""}
      ${
        isHost && player.isBot
          ? `<button data-remove-bot="${text(id)}">Remove</button>`
          : ""
      }
    `;

    list.appendChild(item);
  });

  list.querySelectorAll("[data-remove-bot]").forEach(button => {
    button.addEventListener("click", () => {
      removeBot(button.dataset.removeBot);
    });
  });

  const start = $("startBtn");
  if (start) {
    start.disabled = !isHost ||
      Object.keys(players()).length < 2;
  }
}

async function addBot() {
  if (!isHost || !roomCode) return;

  const snapshot = await get(room());
  const data = snapshot.val();

  if (!data || data.status !== "lobby") return;

  const currentPlayers = data.players || {};
  const count = Object.keys(currentPlayers).length;

  if (count >= 10) {
    message("Maximum 10 players!");
    return;
  }

  const botId = "bot_" + Date.now() + "_" +
    Math.random().toString(36).slice(2, 6);

  await update(room(`players/${botId}`), {
    name: `Bot ${count}`,
    isBot: true,
    connected: true,
    unoCalled: false,
    joinedAt: Date.now()
  });
}

async function removeBot(botId) {
  if (!isHost) return;

  const snapshot = await get(room(`players/${botId}`));
  const player = snapshot.val();

  if (!player?.isBot) return;

  await update(room(), {
    [`players/${botId}`]: null
  });
}

async function startGame() {
  if (!isHost) {
    message("Only the host can start!");
    return;
  }

  const snapshot = await get(room());
  const data = snapshot.val();

  if (!data || Object.keys(data.players || {}).length < 2) {
    message("Need at least 2 players!");
    return;
  }

  const game = initialGame(data.players);
  game.hostId = uid;
  game.chat = data.chat || {};

  await set(room(), game);
}

async function copyRoomCode() {
  try {
    await navigator.clipboard.writeText(roomCode);
    message("Room code copied!");
  } catch {
    message("Room code: " + roomCode);
  }
}

async function leaveRoom() {
  if (!roomCode) return;

  try {
    const snapshot = await get(room());

    if (snapshot.exists()) {
      const data = snapshot.val();

      if (data.status === "lobby") {
        await update(room(), {
          [`players/${uid}`]: null
        });
      } else {
        await update(room(`players/${uid}`), {
          connected: false
        });
      }
    }
  } catch (error) {
    console.error(error);
  }

  roomCode = "";
  state = null;
  isHost = false;
  screen("homeScreen");
}

async function sendChat(inputId) {
  const input = $(inputId);
  const value = input?.value.trim();

  if (!value || !roomCode) return;

  input.value = "";

  await push(room("chat"), {
    name: myName,
    playerId: uid,
    text: value.slice(0, 300),
    time: Date.now()
  });
}

function renderChatMessage(data) {
  const containers = [
    $("lobbyChatMessages"),
    $("gameChatMessages")
  ].filter(Boolean);

  containers.forEach(container => {
    const item = document.createElement("div");
    item.className = "chat-message";

    item.innerHTML = `
      <strong>${text(data.name)}:</strong>
      ${text(data.text)}
    `;

    container.appendChild(item);
    container.scrollTop = container.scrollHeight;
  });
}

async function drawCards(count = 1) {
  const snapshot = await get(room());
  const game = snapshot.val();

  if (!game) return [];

  let deck = [...(game.deck || [])];
  let discard = [...(game.discard || [])];

  if (deck.length < count) {
    const top = discard.pop();
    deck = shuffle([...deck, ...discard]);
    discard = top ? [top] : [];
  }

  const drawn = deck.splice(0, count);

  return { deck, discard, drawn };
}

async function commitMove(cardId, chosenColor = null, targetId = null) {
  if (!roomCode || !isMyTurn()) {
    message("It's not your turn!");
    return;
  }

  let resultMessage = "";

  const result = await runTransaction(room(), current => {
    if (!current || current.status !== "game") return;

    if (current.currentPlayer !== uid) return;

    const hand = current.hands?.[uid] || [];
    const index = hand.findIndex(card => card.id === cardId);

    if (index < 0) return;

    const card = hand[index];

    if (!playable(card, current)) return;

    current.hands[uid].splice(index, 1);
    current.discard ||= [];
    current.discard.push(card);

    current.deck ||= [];
    current.direction ||= 1;
    current.hammerUsed ||= {};
    current.pendingDraw ||= 0;

    if (current.hands[uid].length !== 1) {
      current.players[uid].unoCalled = false;
    }

    if (chosenColor) {
      current.currentColor = chosenColor;
    } else if (card.color) {
      current.currentColor = card.color;
    }

    const ids = Object.keys(current.players || {});

    if (current.hands[uid].length === 0) {
      current.status = "finished";
      current.winner = uid;
      current.lastAction = `${myName} wins!`;
      return current;
    }

    let steps = 1;

    switch (card.value) {
      case "skip":
        steps = 2;
        break;

      case "reverse":
        current.direction *= -1;

        if (ids.length === 2) steps = 2;
        break;

      case "draw2":
        current.pendingDraw = (current.pendingDraw || 0) + 2;
        current.pendingType = "draw2";
        break;

      case "draw4":
        current.pendingDraw = (current.pendingDraw || 0) + 4;
        current.pendingType = "draw4";
        break;
    }

    if (card.value === "swap" && targetId && ids.includes(targetId)) {
      const myHand = current.hands[uid];
      current.hands[uid] = current.hands[targetId];
      current.hands[targetId] = myHand;
    }

    current.currentPlayer = nextPlayer(
      uid,
      steps,
      current.direction,
      ids
    );

    current.lastAction = `${myName} played ${displayCard(card)}`;
    current.revision = (current.revision || 0) + 1;

    return current;
  }, { applyLocally: false });

  if (result.committed) {
    message("Card played!");
  } else {
    message("Move failed. Try again.");
  }
}

async function drawCard() {
  if (!isMyTurn()) {
    message("It's not your turn!");
    return;
  }

  const result = await runTransaction(room(), current => {
    if (!current || current.status !== "game") return;
    if (current.currentPlayer !== uid) return;

    const hand = current.hands?.[uid] || [];
    let deck = [...(current.deck || [])];
    let discard = [...(current.discard || [])];

    const count = current.pendingDraw || 1;

    if (deck.length < count) {
      const top = discard.pop();
      deck = shuffle([...deck, ...discard]);
      discard = top ? [top] : [];
    }

    const drawn = deck.splice(0, count);

    current.hands[uid] = [...hand, ...drawn];
    current.deck = deck;
    current.discard = discard;

    current.pendingDraw = 0;
    current.pendingType = null;

    const ids = Object.keys(current.players || {});
    current.currentPlayer = nextPlayer(
      uid, 1, current.direction || 1, ids
    );

    current.players[uid].unoCalled = false;
    current.lastAction = `${myName} drew ${drawn.length} card(s)`;

    return current;
  }, { applyLocally: false });

  if (!result.committed) {
    message("Unable to draw card!");
  }
}

async function callUno() {
  const hand = state?.hands?.[uid] || [];

  if (hand.length !== 1) {
    message("UNO can be called when you have 1 card!");
    return;
  }

  await update(room(`players/${uid}`), {
    unoCalled: true
  });

  message("UNO!");
}

async function useHammer() {
  if (!state || !roomCode) return;

  const opponents = Object.keys(state.hands || {}).filter(id =>
    id !== uid &&
    state.hands[id]?.length === 1 &&
    !state.players?.[id]?.unoCalled
  );

  if (!opponents.length) {
    message("No opponent to challenge!");
    return;
  }

  const targetId = opponents[0];

  const result = await runTransaction(room(), current => {
    if (!current || current.status !== "game") return;

    current.hammerUsed ||= {};

    if (current.hammerUsed[uid]) return;

    const targetHand = current.hands?.[targetId] || [];

    if (
      targetHand.length !== 1 ||
      current.players?.[targetId]?.unoCalled
    ) {
      return;
    }

    let deck = [...(current.deck || [])];
    let discard = [...(current.discard || [])];

    if (deck.length < 2) {
      const top = discard.pop();
      deck = shuffle([...deck, ...discard]);
      discard = top ? [top] : [];
    }

    const penalty = deck.splice(0, 2);

    current.hands[targetId] = [...targetHand, ...penalty];
    current.deck = deck;
    current.discard = discard;
    current.hammerUsed[uid] = true;
    current.lastAction =
      `${current.players[targetId].name} was hammered and drew ${penalty.length} cards`;

    return current;
  }, { applyLocally: false });

  message(result.committed ? "Hammer successful! +2 cards." : "Hammer failed!");
}

function renderGame() {
  if (!state) return;

  const handContainer = $("playerHand");
  const opponentContainer = $("opponents");
  const discardContainer = $("discardPile");
  const deckContainer = $("drawPile");

  if ($("gameRoomCode")) {
    $("gameRoomCode").textContent = roomCode;
  }

  if ($("gameStatus")) {
    $("gameStatus").textContent =
      state.status === "finished"
        ? `${state.players?.[state.winner]?.name || "Player"} wins!`
        : isMyTurn()
          ? "Your turn!"
          : `${state.players?.[state.currentPlayer]?.name || "Player"}'s turn`;
  }

  if ($("currentColor")) {
    $("currentColor").textContent =
      state.currentColor || "red";
  }

  if (discardContainer) {
    const top = topCard();
    discardContainer.innerHTML = top ? cardHtml(top) : "";
  }

  if (deckContainer) {
    deckContainer.innerHTML = `
      <button id="drawCardButton" class="play-card wild">
        DRAW
      </button>
    `;

    $("drawCardButton").addEventListener("click", drawCard);
  }

  if (handContainer) {
    const hand = state.hands?.[uid] || [];

    handContainer.innerHTML = hand.map(card => `
      <button
        class="hand-card ${cardClass(card)}"
        data-card-id="${text(card.id)}"
        ${!isMyTurn() || !playable(card) ? "disabled" : ""}
      >
        ${text(displayCard(card))}
      </button>
    `).join("");

    handContainer.querySelectorAll("[data-card-id]")
      .forEach(button => {
        button.addEventListener("click", () => {
          const cardId = button.dataset.cardId;
          const card = hand.find(c => c.id === cardId);

          if (!card) return;

          if (
            card.type === "wild" ||
            card.type === "wildDraw4"
          ) {
            openColorModal(card);
          } else if (
            card.value === "swap" ||
            card.value === "colorPunishment"
          ) {
            openTargetModal(card);
          } else {
            commitMove(card.id);
          }
        });
      });
  }

  if (opponentContainer) {
    opponentContainer.innerHTML = "";

    Object.entries(players()).forEach(([id, player]) => {
      if (id === uid) return;

      const div = document.createElement("div");
      div.className = "opponent";

      div.innerHTML = `
        <strong>${text(player.name)}</strong>
        <span>${state.hands?.[id]?.length || 0} cards</span>
        ${id === state.currentPlayer ? "<b>TURN</b>" : ""}
      `;

      opponentContainer.appendChild(div);
    });
  }

  if ($("unoBtn")) {
    $("unoBtn").disabled =
      (state.hands?.[uid] || []).length !== 1;
  }

  if ($("hammerBtn")) {
    $("hammerBtn").disabled = !Object.keys(state.hands || {})
      .some(id =>
        id !== uid &&
        state.hands[id]?.length === 1 &&
        !state.players?.[id]?.unoCalled
      );
  }
}

function openColorModal(card) {
  pending = { card };

  const modal = $("colorModal");

  if (modal) {
    modal.style.display = "flex";
  }
}

function closeColorModal() {
  const modal = $("colorModal");

  if (modal) {
    modal.style.display = "none";
  }

  pending = null;
}

function chooseColor(color) {
  if (!pending?.card) return;

  const card = pending.card;

  closeColorModal();
  commitMove(card.id, color);
}

function openTargetModal(card) {
  pending = { card };

  const modal = $("targetModal");
  const list = $("targetList");

  if (!modal || !list) {
    message("Target selection is unavailable.");
    pending = null;
    return;
  }

  const opponents = Object.entries(players())
    .filter(([id]) => id !== uid);

  list.innerHTML = opponents.map(([id, player]) => `
    <button class="target-option" data-target-id="${text(id)}">
      ${text(player.name)}
      (${state.hands?.[id]?.length || 0} cards)
    </button>
  `).join("");

  list.querySelectorAll("[data-target-id]")
    .forEach(button => {
      button.addEventListener("click", () => {
        const targetId = button.dataset.targetId;
        const selected = pending?.card;

        if (!selected) return;

        modal.style.display = "none";
        pending = null;

        commitMove(selected.id, null, targetId);
      });
    });

  modal.style.display = "flex";
}

function closeTargetModal() {
  const modal = $("targetModal");

  if (modal) {
    modal.style.display = "none";
  }

  pending = null;
}

async function runBotTurn() {
  if (!isHost || !state || state.status !== "game") return;

  const playerId = state.currentPlayer;
  const player = state.players?.[playerId];

  if (!player?.isBot) return;

  const actionKey = `${roomCode}_${playerId}_${state.revision}`;

  if (lastBotAction === actionKey) return;

  lastBotAction = actionKey;

  clearTimeout(botTimer);

  botTimer = setTimeout(async () => {
    const snapshot = await get(room());

    if (!snapshot.exists()) return;

    const game = snapshot.val();

    if (
      game.status !== "game" ||
      game.currentPlayer !== playerId
    ) {
      return;
    }

    const hand = game.hands?.[playerId] || [];
    const card = hand.find(c => playable(c, game));

    if (!card) {
      await botDraw(playerId);
      return;
    }

    let color = card.color;

    if (
      card.type === "wild" ||
      card.type === "wildDraw4"
    ) {
      const counts = Object.fromEntries(
        COLORS.map(c => [
          c,
          hand.filter(item => item.color === c).length
        ])
      );

      color = COLORS.sort(
        (a, b) => counts[b] - counts[a]
      )[0];
    }

    await botPlay(playerId, card, color);
  }, 1000);
}

async function botDraw(botId) {
  await runTransaction(room(), current => {
    if (
      !current ||
      current.status !== "game" ||
      current.currentPlayer !== botId
    ) {
      return;
    }

    let deck = [...(current.deck || [])];
    let discard = [...(current.discard || [])];

    if (!deck.length && discard.length > 1) {
      const top = discard.pop();
      deck = shuffle(discard);
      discard = [top];
    }

    const drawn = deck.shift();

    if (drawn) {
      current.hands[botId].push(drawn);
    }

    current.deck = deck;
    current.discard = discard;

    current.pendingDraw = 0;
    current.pendingType = null;

    current.currentPlayer = nextPlayer(
      botId,
      1,
      current.direction || 1,
      Object.keys(current.players)
    );

    current.lastAction =
      `${current.players[botId].name} drew a card`;

    current.revision = (current.revision || 0) + 1;

    return current;
  }, { applyLocally: false });
}

async function botPlay(botId, card, color) {
  await runTransaction(room(), current => {
    if (
      !current ||
      current.status !== "game" ||
      current.currentPlayer !== botId
    ) {
      return;
    }

    const hand = current.hands?.[botId] || [];
    const index = hand.findIndex(c => c.id === card.id);

    if (index < 0 || !playable(card, current)) return;

    hand.splice(index, 1);
    current.discard.push(card);

    if (hand.length !== 1) {
      current.players[botId].unoCalled = false;
    }

    current.currentColor = color || card.color || current.currentColor;

    if (hand.length === 0) {
      current.status = "finished";
      current.winner = botId;
      current.lastAction =
        `${current.players[botId].name} wins!`;
      return current;
    }

    const ids = Object.keys(current.players);
    let steps = 1;

    if (card.value === "skip") steps = 2;

    if (card.value === "reverse") {
      current.direction *= -1;
      if (ids.length === 2) steps = 2;
    }

    if (card.value === "draw2") {
      current.pendingDraw = (current.pendingDraw || 0) + 2;
      current.pendingType = "draw2";
    }

    if (card.value === "draw4") {
      current.pendingDraw = (current.pendingDraw || 0) + 4;
      current.pendingType = "draw4";
    }

    current.currentPlayer = nextPlayer(
      botId,
      steps,
      current.direction,
      ids
    );

    current.lastAction =
      `${current.players[botId].name} played ${displayCard(card)}`;

    current.revision = (current.revision || 0) + 1;

    return current;
  }, { applyLocally: false });
}

function bindButtons() {
  $("createBtn")?.addEventListener("click", createRoom);
  $("joinBtn")?.addEventListener("click", joinRoom);
  $("startBtn")?.addEventListener("click", startGame);
  $("addBotBtn")?.addEventListener("click", addBot);

  $("copyRoomBtn")?.addEventListener("click", copyRoomCode);
  $("leaveLobbyBtn")?.addEventListener("click", leaveRoom);
  $("leaveGameBtn")?.addEventListener("click", leaveRoom);

  $("drawBtn")?.addEventListener("click", drawCard);
  $("unoBtn")?.addEventListener("click", callUno);
  $("hammerBtn")?.addEventListener("click", useHammer);

  $("lobbyChatForm")?.addEventListener("submit", event => {
    event.preventDefault();
    sendChat("lobbyChatInput");
  });

  $("gameChatForm")?.addEventListener("submit", event => {
    event.preventDefault();
    sendChat("gameChatInput");
  });

  document.querySelectorAll("[data-color]")
    .forEach(button => {
      button.addEventListener("click", () => {
        chooseColor(button.dataset.color);
      });
    });

  $("closeColorModal")?.addEventListener(
    "click", closeColorModal
  );

  $("closeTargetModal")?.addEventListener(
    "click", closeTargetModal
  );
}

bindButtons();

console.log("UNO Royale app.js loaded.");