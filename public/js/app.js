const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const CAT_RU = {
  views: "просмотры",
  likes: "лайки",
  comments: "комментарии",
  subs: "подписки",
};

const state = {
  user: null,
  category: "views",
  task: null,
  authMode: "login",
  watch: null,
  ws: null,
};

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Ошибка эфира");
  return data;
}

function nickColor(nick) {
  let h = 0;
  for (const c of nick) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  const palette = ["#ff2d00", "#f0cf6a", "#3dff8a", "#f3eadb", "#7ab8ff", "#ff8a5b"];
  return palette[h % palette.length];
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/* ---------- landing clock ---------- */
function tickClock() {
  const el = $("#land-clock");
  if (!el) return;
  const d = new Date();
  el.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}
setInterval(tickClock, 1000);
tickClock();

fetch("/api/public")
  .then((r) => r.json())
  .then((s) => {
    const el = $("#land-stats");
    if (el) el.textContent = `${s.players} игроков · ${s.videos} в эфире`;
  })
  .catch(() => {});

/* ---------- auth ---------- */
$$(".auth-tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.authMode = btn.dataset.mode;
    $$(".auth-tabs button").forEach((b) => b.classList.toggle("on", b === btn));
    $("#auth-submit").textContent =
      state.authMode === "login" ? "Войти в студию" : "Создать игрока";
  });
});

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const nick = String(fd.get("nick") || "").trim();
  const password = String(fd.get("password") || "");
  const err = $("#auth-err");
  err.hidden = true;
  try {
    const path = state.authMode === "register" ? "/api/register" : "/api/login";
    const data = await api(path, { method: "POST", body: { nick, password } });
    state.user = data.user;
    await enterStudio();
  } catch (ex) {
    err.hidden = false;
    err.textContent = ex.message;
  }
});

$("#btn-out").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

/* ---------- studio boot ---------- */
async function enterStudio() {
  $("#landing").hidden = true;
  $("#studio").hidden = false;
  const snap = await api("/api/state");
  state.user = snap.user;
  paintUser();
  paintStats(snap.stats);
  paintOnline(snap.online);
  paintLeaders(snap.stats.leaders);
  paintTicker(snap.activity);
  $("#chat-log").innerHTML = "";
  if (!snap.chat.length) {
    appendSys("Чат эфира открыт. Игроки на связи.");
  } else {
    snap.chat.forEach(appendMsg);
  }
  connectWs();
  await loadTask();
}

function paintUser() {
  const u = state.user;
  $("#who-nick").textContent = u.nick;
  $("#rank-label").textContent = u.rank;
  paintMeter();
}

function paintMeter() {
  const n = state.user.credits[state.category] || 0;
  const filled = Math.min(3, n);
  $$("#dots i").forEach((d, i) => d.classList.toggle("on", i < filled));
  $("#meter-num").textContent = `${n}/3`;
  $("#meter-kicker").textContent = n >= 3 ? "готово к эфиру" : "до эфира";
  $("#btn-publish").disabled = n < 3;
}

function paintStats(stats) {
  if (!stats) return;
  const q = stats.queue || {};
  $("#q-views").textContent = q.views ?? 0;
  $("#q-likes").textContent = q.likes ?? 0;
  $("#q-comments").textContent = q.comments ?? 0;
  $("#q-subs").textContent = q.subs ?? 0;
  $("#online-count").textContent = `${stats.online ?? 0} онлайн`;
  if (stats.leaders) paintLeaders(stats.leaders);
}

function paintOnline(list) {
  const ul = $("#online-list");
  ul.innerHTML = "";
  (list || []).forEach((p) => {
    const li = document.createElement("li");
    if (state.user && p.nick === state.user.nick) li.classList.add("me");
    li.textContent = p.nick;
    ul.append(li);
  });
}

function paintLeaders(list) {
  const ol = $("#leaders");
  ol.innerHTML = "";
  (list || []).forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${i + 1}. ${esc(p.nick)}</span><span>${p.total}</span>`;
    ol.append(li);
  });
}

function paintTicker(items) {
  const el = $("#ticker");
  const arr = items && items.length ? items : [{ text: "Эфир открыт · 1 своё через 3 чужих · rutube.ru" }];
  el.innerHTML = `<div class="ticker-track">${arr
    .map((a) => `<span><b>▶</b> ${esc(a.text)}</span>`)
    .join("")}</div>`;
}

/* ---------- categories ---------- */
$("#cats").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-cat]");
  if (!btn) return;
  state.category = btn.dataset.cat;
  $$("#cats button").forEach((b) => b.classList.toggle("on", b === btn));
  paintMeter();
  stopWatch();
  await loadTask();
});

/* ---------- tasks ---------- */
async function loadTask(skip) {
  const q = skip ? `?skip=${encodeURIComponent(skip)}` : "";
  const data = await api(`/api/task/${state.category}${q}`);
  if (data.credits) {
    state.user.credits = data.credits;
    paintMeter();
  }
  state.task = data.task;
  renderTask();
}

function renderTask() {
  const task = state.task;
  $("#empty").hidden = !!task;
  $("#task-wrap").hidden = !task;
  if (!task) return;

  $("#task-kicker").textContent = `Категория · ${CAT_RU[state.category]}`;
  $("#task-title").textContent = task.title;
  $("#task-author").textContent = task.author || "Автор на Rutube";
  $("#task-owner").textContent = `эфир: ${task.ownerNick}`;
  const openUrl =
    state.category === "subs" ? task.channelUrl || task.url : task.url;
  $("#task-open").href = openUrl;

  const slot = $("#player-slot");
  slot.innerHTML = "";
  if (task.embedUrl && state.category !== "subs") {
    const iframe = document.createElement("iframe");
    iframe.src = task.embedUrl;
    iframe.allow = "clipboard-write; autoplay; fullscreen; encrypted-media";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    slot.append(iframe);
  } else {
    const ph = document.createElement("div");
    ph.className = "ph";
    ph.innerHTML = `<div><p class="kicker">Канал</p><strong>${esc(
      task.author || task.title,
    )}</strong><p>Открой страницу на rutube.ru и подпишись</p></div>`;
    slot.append(ph);
  }

  $("#watch-fill").style.width = "0%";
  $("#rec-flag").hidden = true;
  renderDock();
}

function renderDock() {
  const dock = $("#action-dock");
  const cat = state.category;
  if (cat === "views") {
    dock.innerHTML = `
      <h3>Смотри не меньше 20 секунд</h3>
      <p>Запусти ролик. Не сворачивай вкладку — таймер идёт только пока ты в эфире.</p>
      <div class="action-row">
        <div class="timecode" id="tc">00:20.0</div>
        <button class="btn-red" type="button" id="btn-start">Начать просмотр</button>
        <button class="btn-red" type="button" id="btn-done" hidden>Засчитать просмотр</button>
      </div>
      <p class="hint" id="watch-hint">1 своё через 3 чужих · категория просмотры</p>
    `;
    $("#btn-start").onclick = startWatch;
    $("#btn-done").onclick = () => completeTask();
    return;
  }
  if (cat === "likes") {
    dock.innerHTML = `
      <h3>Поставь лайк на Rutube</h3>
      <p>Открой ролик, нажми лайк, вернись и подтверди. Засчитываем не раньше чем через 8 секунд.</p>
      <div class="action-row">
        <button class="btn-ghost" type="button" id="btn-go">Открыть и лайкнуть</button>
        <button class="btn-red" type="button" id="btn-done" disabled>Я поставил лайк</button>
      </div>
      <p class="hint" id="watch-hint">После открытия кнопки подтверждения загорятся.</p>
    `;
    wireOpenConfirm();
    return;
  }
  if (cat === "comments") {
    dock.innerHTML = `
      <h3>Оставь комментарий под роликом</h3>
      <p>Напиши текст здесь, скопируй на Rutube, затем подтверди.</p>
      <textarea id="comment-text" maxlength="400" placeholder="Живой комментарий от 12 символов…"></textarea>
      <div class="action-row">
        <button class="btn-ghost" type="button" id="btn-copy">Скопировать</button>
        <button class="btn-ghost" type="button" id="btn-go">Открыть Rutube</button>
        <button class="btn-red" type="button" id="btn-done" disabled>Я оставил комментарий</button>
      </div>
      <p class="hint" id="watch-hint">Пиши по делу — это увидит автор.</p>
    `;
    $("#btn-copy").onclick = async () => {
      const t = $("#comment-text").value.trim();
      if (t.length < 12) return toast("Сначала напиши комментарий");
      await navigator.clipboard.writeText(t);
      toast("Скопировано. Вставь под роликом.");
    };
    wireOpenConfirm();
    return;
  }
  dock.innerHTML = `
    <h3>Подпишись на канал</h3>
    <p>Открой канал автора на rutube.ru, нажми «Подписаться», вернись и подтверди.</p>
    <div class="action-row">
      <button class="btn-ghost" type="button" id="btn-go">Открыть канал</button>
      <button class="btn-red" type="button" id="btn-done" disabled>Я подписался</button>
    </div>
    <p class="hint" id="watch-hint">Подписка должна остаться. Это живой обмен.</p>
  `;
  wireOpenConfirm();
}

function wireOpenConfirm() {
  const go = $("#btn-go");
  const done = $("#btn-done");
  go.onclick = async () => {
    if (!state.task) return;
    await api(`/api/task/${state.task.id}/open`, { method: "POST" });
    const href = $("#task-open").href;
    window.open(href, "_blank", "noopener");
    done.disabled = true;
    $("#watch-hint").textContent = "Сделай действие на Rutube…";
    setTimeout(() => {
      done.disabled = false;
      $("#watch-hint").textContent = "Можно подтверждать.";
    }, 8000);
  };
  done.onclick = () => completeTask();
}

/* ---------- watch 20s ---------- */
function stopWatch() {
  if (state.watch?.raf) cancelAnimationFrame(state.watch.raf);
  if (state.watch?.beat) clearInterval(state.watch.beat);
  state.watch = null;
  const rec = $("#rec-flag");
  if (rec) rec.hidden = true;
}

async function startWatch() {
  if (!state.task) return;
  stopWatch();
  await api(`/api/task/${state.task.id}/start`, { method: "POST" });
  tryPlay();
  $("#rec-flag").hidden = false;
  $("#btn-start").hidden = true;
  const done = $("#btn-done");
  done.hidden = true;
  state.watch = {
    visibleMs: 0,
    last: 0,
    running: true,
    playing: true,
    raf: null,
    beat: setInterval(sendBeat, 4000),
  };
  sendBeat();
  state.watch.raf = requestAnimationFrame(watchFrame);
}

function tryPlay() {
  const iframe = $("#player-slot iframe");
  if (!iframe?.contentWindow) return;
  iframe.contentWindow.postMessage(
    JSON.stringify({ type: "player:play", data: {} }),
    "*",
  );
}

function watchFrame(ts) {
  const w = state.watch;
  if (!w?.running) return;
  if (document.visibilityState === "visible") {
    if (w.last) w.visibleMs += ts - w.last;
    w.last = ts;
  } else {
    w.last = 0;
  }
  const need = 20_000;
  const left = Math.max(0, need - w.visibleMs);
  const sec = left / 1000;
  const tc = $("#tc");
  if (tc) {
    const s = Math.floor(sec);
    const ds = Math.floor((sec - s) * 10);
    tc.textContent = `00:${String(s).padStart(2, "0")}.${ds}`;
  }
  $("#watch-fill").style.width = `${Math.min(100, (w.visibleMs / need) * 100)}%`;
  if (w.visibleMs >= need) {
    w.running = false;
    const done = $("#btn-done");
    if (done) done.hidden = false;
    if (tc) {
      tc.textContent = "00:00.0";
      tc.classList.add("ready");
    }
    $("#watch-hint").textContent = "20 секунд в эфире. Можно засчитывать.";
    return;
  }
  w.raf = requestAnimationFrame(watchFrame);
}

async function sendBeat() {
  if (!state.task || !state.watch) return;
  try {
    await api(`/api/task/${state.task.id}/beat`, { method: "POST" });
  } catch {
    /* ignore mid-flight */
  }
}

window.addEventListener("message", (e) => {
  if (!state.watch) return;
  let msg = e.data;
  if (typeof msg === "string") {
    try {
      msg = JSON.parse(msg);
    } catch {
      return;
    }
  }
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "player:changeState") {
    const s = msg.data?.state;
    state.watch.playing = s === "playing" || s === "play";
  }
});

async function completeTask() {
  if (!state.task) return;
  const body = {};
  if (state.category === "comments") {
    body.comment = $("#comment-text")?.value.trim() || "";
    if (body.comment.length < 12) {
      toast("Комментарий от 12 символов");
      return;
    }
  }
  try {
    const data = await api(`/api/task/${state.task.id}/complete`, {
      method: "POST",
      body,
    });
    stopWatch();
    state.user = data.user;
    paintUser();
    toast("Засчитано. +1 к эфиру");
    state.task = data.next;
    renderTask();
    if (!data.next) {
      $("#empty").hidden = false;
      $("#task-wrap").hidden = true;
    }
  } catch (ex) {
    toast(ex.message);
  }
}

$("#btn-skip").addEventListener("click", async () => {
  if (!state.task) return;
  stopWatch();
  await loadTask(state.task.id);
});

/* ---------- publish / overlays ---------- */
function openOverlay(id) {
  $(id).hidden = false;
}
function closeOverlays() {
  $$(".overlay").forEach((o) => (o.hidden = true));
}
$$("[data-close]").forEach((b) => b.addEventListener("click", closeOverlays));
$$(".overlay").forEach((o) =>
  o.addEventListener("click", (e) => {
    if (e.target === o) closeOverlays();
  }),
);

$("#btn-publish").addEventListener("click", () => {
  $("#pub-cat").value = state.category;
  updatePubCost();
  openOverlay("#overlay-publish");
});
$("#empty-publish").addEventListener("click", () => $("#btn-publish").click());
$("#btn-rules").addEventListener("click", () => openOverlay("#overlay-rules"));
$("#btn-mine").addEventListener("click", async () => {
  await loadMine();
  openOverlay("#overlay-mine");
});
$("#btn-chat").addEventListener("click", () => {
  $("#chat-panel").classList.toggle("open");
});

$("#pub-cat").addEventListener("change", updatePubCost);
function updatePubCost() {
  const cat = $("#pub-cat").value;
  const n = state.user?.credits[cat] || 0;
  $("#pub-cost").textContent = `Стоимость: 3 ${CAT_RU[cat]} · у тебя ${n}`;
}

let previewTimer;
$("#pub-url").addEventListener("input", () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(loadPreview, 500);
});

async function loadPreview() {
  const url = $("#pub-url").value.trim();
  const box = $("#pub-preview");
  if (!url) {
    box.hidden = true;
    return;
  }
  try {
    const p = await api("/api/preview", { method: "POST", body: { url } });
    box.hidden = false;
    box.innerHTML = `
      ${p.thumb ? `<img src="${esc(p.thumb)}" alt="">` : `<div></div>`}
      <div>
        <strong>${esc(p.title)}</strong>
        <p class="hint">${esc(p.author || "Rutube")}</p>
      </div>`;
    if (p.title && !$("#pub-title").value) $("#pub-title").value = p.title;
  } catch (ex) {
    box.hidden = false;
    box.innerHTML = `<div></div><div>${esc(ex.message)}</div>`;
  }
}

$("#publish-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#pub-err");
  err.hidden = true;
  const body = {
    url: $("#pub-url").value.trim(),
    category: $("#pub-cat").value,
    title: $("#pub-title").value.trim(),
  };
  try {
    const data = await api("/api/publish", { method: "POST", body });
    state.user = data.user;
    paintUser();
    toast("В эфире. Игроки его увидят.");
    closeOverlays();
    e.target.reset();
    $("#pub-preview").hidden = true;
  } catch (ex) {
    err.hidden = false;
    err.textContent = ex.message;
  }
});

async function loadMine() {
  const data = await api("/api/mine");
  const box = $("#mine-list");
  if (!data.mine.length) {
    box.innerHTML = "<p>Ты ещё не публиковал ролики. Три чужих — и можно своё.</p>";
    return;
  }
  box.innerHTML = data.mine
    .map(
      (v) => `
      <article class="mine-card ${v.active ? "" : "off"}">
        <header>
          <h3>${esc(v.title)}</h3>
          <span class="tag">${esc(CAT_RU[v.category])} · ${v.received}</span>
        </header>
        <p class="hint">${esc(v.url)}</p>
        ${
          v.comments?.length
            ? `<p class="comments-mini">${v.comments
                .map((c) => `«${esc(c.text)}» — ${esc(c.nick)}`)
                .join("<br>")}</p>`
            : ""
        }
        <button type="button" class="btn-ghost" data-toggle="${v.id}">${
          v.active ? "Снять с эфира" : "Вернуть в эфир"
        }</button>
      </article>`,
    )
    .join("");
  box.querySelectorAll("[data-toggle]").forEach((b) => {
    b.onclick = async () => {
      await api(`/api/mine/${b.dataset.toggle}/toggle`, { method: "POST" });
      await loadMine();
    };
  });
}

/* ---------- chat / ws ---------- */
function appendMsg(item) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<div class="meta"><span class="nick" style="color:${nickColor(
    item.nick,
  )}">${esc(item.nick)}</span>${fmtTime(item.at)}</div>
    <div class="body"></div>`;
  div.querySelector(".body").textContent = item.text;
  log.append(div);
  log.scrollTop = log.scrollHeight;
}

function appendSys(text) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = "msg sys";
  div.innerHTML = `<div class="body"></div>`;
  div.querySelector(".body").textContent = text;
  log.append(div);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOverlays();
});

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text || !state.ws || state.ws.readyState !== 1) return;
  state.ws.send(JSON.stringify({ type: "chat", text }));
  input.value = "";
});

let pingTimer = 0;

function connectWs() {
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "hello") {
      paintOnline(msg.online);
      paintStats(msg.stats);
    }
    if (msg.type === "chat" && msg.item) appendMsg(msg.item);
    if (msg.type === "presence") {
      paintOnline(msg.online);
      paintStats(msg.stats);
    }
    if (msg.type === "stats") paintStats(msg.stats);
    if (msg.type === "activity" && msg.item) {
      const track = $(".ticker-track");
      if (track) {
        const span = document.createElement("span");
        span.innerHTML = `<b>▶</b> ${esc(msg.item.text)}`;
        track.append(span);
      }
    }
    if (msg.type === "error") toast(msg.error);
  });
  ws.addEventListener("close", () => {
    if (!state.user) return;
    setTimeout(connectWs, 1600);
  });
  if (!pingTimer) {
    pingTimer = setInterval(() => {
      if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: "ping" }));
    }, 25000);
  }
}

/* ---------- boot ---------- */
api("/api/me")
  .then(async (d) => {
    state.user = d.user;
    await enterStudio();
  })
  .catch(() => {
    $("#landing").hidden = false;
    $("#studio").hidden = true;
  });
