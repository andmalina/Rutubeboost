import http from "http";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import { WebSocketServer } from "ws";
import { createStore } from "./store.js";
import { parseRutube, fetchMeta, embedUrl, thumbUrl } from "./rutube.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const COOKIE = "rb_sid";
const CATEGORIES = ["views", "likes", "comments", "subs"];
const WATCH_MS = 20_000;
const ACTION_GAP_MS = 8_000;
const COST = 3;

const store = createStore(path.join(__dirname, "data", "db.json"));
const watches = new Map();
const sockets = new Map();
const buckets = new Map();

const CAT_RU = {
  views: "просмотры",
  likes: "лайки",
  comments: "комментарии",
  subs: "подписки",
};
const CAT_GEN = {
  views: "просмотра",
  likes: "лайка",
  comments: "комментария",
  subs: "подписки",
};

const SEED = [
  {
    videoId: "55efc447917fe974bcf08c74b4ad3f95",
    title: "Как скачать видео с Рутуба",
    author: "Виктор Христов",
  },
  {
    videoId: "17e5afcb214ec120bff7a995d6f0ff28",
    title: "Непрошеные советы — полный выпуск",
    author: "RUTUBE",
    channelUrl: "https://rutube.ru/u/rutube/",
  },
  {
    videoId: "522b9f934aeea2ec9eca8a6cc2005d2f",
    title: "Как посмотреть просмотры на Rutube",
    author: "Виктор Христов",
  },
  {
    videoId: "c58f502c7bb34a8fcdd976b221fca292",
    title: "Ролик с канала RUTUBE",
    author: "RUTUBE",
    channelUrl: "https://rutube.ru/u/rutube/",
  },
];

function id() {
  return crypto.randomBytes(8).toString("hex");
}

function now() {
  return Date.now();
}

function rateLimit(key, n, ms) {
  const t = now();
  let hits = buckets.get(key) || [];
  hits = hits.filter((x) => t - x < ms);
  if (hits.length >= n) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(t);
  buckets.set(key, hits);
  return true;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "0.0.0.0";
}

function publicUser(u) {
  return {
    id: u.id,
    nick: u.nick,
    credits: u.credits,
    stats: u.stats,
    rank: rankOf(u),
    createdAt: u.createdAt,
  };
}

function rankOf(u) {
  const total =
    (u.stats?.done?.views || 0) +
    (u.stats?.done?.likes || 0) +
    (u.stats?.done?.comments || 0) +
    (u.stats?.done?.subs || 0);
  if (total >= 150) return "Эфир";
  if (total >= 50) return "Продюсер";
  if (total >= 15) return "Режиссёр";
  if (total >= 3) return "Оператор";
  return "Стажёр";
}

function emptyCredits() {
  return { views: 0, likes: 0, comments: 0, subs: 0 };
}

function emptyStats() {
  return { done: emptyCredits(), received: emptyCredits() };
}

function seedIfNeeded() {
  if (store.data.videos.length) return;
  const createdAt = now();
  for (const cat of CATEGORIES) {
    for (const item of SEED) {
      store.data.videos.push({
        id: id(),
        userId: "studio",
        category: cat,
        videoId: item.videoId,
        url: `https://rutube.ru/video/${item.videoId}/`,
        embedUrl: embedUrl(item.videoId),
        title: item.title,
        author: item.author,
        thumb: thumbUrl(item.videoId),
        channelUrl: item.channelUrl || `https://rutube.ru/video/${item.videoId}/`,
        createdAt,
        received: 0,
        active: true,
        system: true,
      });
    }
  }
  store.save();
}

seedIfNeeded();

function userBySession(token) {
  if (!token) return null;
  const session = store.data.sessions.find((s) => s.token === token && s.exp > now());
  if (!session) return null;
  return store.data.users.find((u) => u.id === session.userId) || null;
}

function authUser(req) {
  return userBySession(req.cookies?.[COOKIE]);
}

function requireUser(req, res, next) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "Нужно войти в студию" });
  req.user = user;
  next();
}

function setSession(res, userId, req) {
  const token = crypto.randomBytes(24).toString("hex");
  const exp = now() + 1000 * 60 * 60 * 24 * 30;
  store.mutate((d) => {
    d.sessions = d.sessions.filter((s) => s.exp > now() && s.userId !== userId);
    d.sessions.push({ token, userId, exp });
  });
  const secure =
    req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: "/",
  });
}

function validNick(nick) {
  return typeof nick === "string" && /^[a-zA-Zа-яА-ЯёЁ0-9_\- ]{2,20}$/.test(nick.trim());
}

function validPass(password) {
  return typeof password === "string" && password.length >= 4 && password.length <= 72;
}

function pushActivity(text, kind, extra = {}) {
  store.mutate((d) => {
    d.activity.push({ id: id(), text, kind, at: now(), ...extra });
    if (d.activity.length > 80) d.activity = d.activity.slice(-80);
  });
  broadcast({ type: "activity", item: store.data.activity.at(-1) });
}

function queueCounts() {
  const counts = { views: 0, likes: 0, comments: 0, subs: 0 };
  for (const v of store.data.videos) {
    if (v.active) counts[v.category] += 1;
  }
  return counts;
}

function leaders() {
  return store.data.users
    .map((u) => ({
      nick: u.nick,
      total:
        (u.stats?.done?.views || 0) +
        (u.stats?.done?.likes || 0) +
        (u.stats?.done?.comments || 0) +
        (u.stats?.done?.subs || 0),
      rank: rankOf(u),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);
}

function todayCount() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t = start.getTime();
  return store.data.completions.filter((c) => c.at >= t).length;
}

function onlineNicks() {
  const list = [];
  const seen = new Set();
  for (const info of sockets.values()) {
    if (seen.has(info.userId)) continue;
    seen.add(info.userId);
    list.push({ nick: info.nick, userId: info.userId });
  }
  return list;
}

function publicVideo(v) {
  return {
    id: v.id,
    category: v.category,
    videoId: v.videoId,
    url: v.url,
    embedUrl: v.embedUrl,
    title: v.title,
    author: v.author,
    thumb: v.thumb,
    channelUrl: v.channelUrl,
    received: v.received,
    ownerNick:
      v.userId === "studio"
        ? "Студия"
        : store.data.users.find((u) => u.id === v.userId)?.nick || "Игрок",
    system: !!v.system,
  };
}

function nextTask(user, category, skipId) {
  const done = new Set(
    store.data.completions
      .filter((c) => c.userId === user.id && c.category === category)
      .map((c) => c.videoKey),
  );
  const pool = store.data.videos.filter(
    (v) =>
      v.active &&
      v.category === category &&
      v.userId !== user.id &&
      !done.has(v.id) &&
      v.id !== skipId,
  );
  pool.sort((a, b) => a.received - b.received || a.createdAt - b.createdAt);
  return pool[0] || null;
}

function globalStats() {
  return {
    online: onlineNicks().length,
    videos: store.data.videos.filter((v) => v.active).length,
    players: store.data.users.length,
    today: todayCount(),
    queue: queueCounts(),
    leaders: leaders(),
  };
}

function snapshot(user) {
  return {
    user: publicUser(user),
    stats: globalStats(),
    chat: store.data.chat.slice(-80),
    activity: store.data.activity.slice(-24),
    online: onlineNicks(),
  };
}

function broadcast(payload, exceptWs = null) {
  const raw = JSON.stringify(payload);
  for (const [ws] of sockets) {
    if (ws === exceptWs) continue;
    if (ws.readyState === 1) ws.send(raw);
  }
}

function broadcastPresence() {
  broadcast({ type: "presence", online: onlineNicks(), stats: globalStats() });
}

function actionLabel(cat) {
  return {
    views: "посмотрел(а)",
    likes: "лайкнул(а)",
    comments: "прокомментировал(а)",
    subs: "подписался(ась)",
  }[cat];
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(cookieParser());
app.use(express.json({ limit: "48kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
    maxAge: process.env.NODE_ENV === "production" ? "7d" : 0,
  }),
);

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

app.post(
  "/api/register",
  wrap(async (req, res) => {
    if (!rateLimit(clientIp(req) + ":reg", 8, 60_000)) {
      return res.status(429).json({ error: "Слишком много попыток. Подожди минуту." });
    }
    const nick = String(req.body?.nick || "").trim();
    const password = String(req.body?.password || "");
    if (!validNick(nick)) {
      return res.status(400).json({ error: "Ник: 2–20 символов, буквы, цифры, _ и -" });
    }
    if (!validPass(password)) {
      return res.status(400).json({ error: "Пароль от 4 символов" });
    }
    const taken = store.data.users.some(
      (u) => u.nick.toLowerCase() === nick.toLowerCase(),
    );
    if (taken) return res.status(409).json({ error: "Такой ник уже в эфире" });
    const user = {
      id: id(),
      nick,
      passHash: bcrypt.hashSync(password, 10),
      createdAt: now(),
      credits: emptyCredits(),
      stats: emptyStats(),
    };
    store.mutate((d) => d.users.push(user));
    setSession(res, user.id, req);
    pushActivity(`«${nick}» вошёл в студию`, "join");
    res.json({ user: publicUser(user) });
  }),
);

app.post(
  "/api/login",
  wrap(async (req, res) => {
    if (!rateLimit(clientIp(req) + ":login", 12, 60_000)) {
      return res.status(429).json({ error: "Слишком много попыток. Подожди минуту." });
    }
    const nick = String(req.body?.nick || "").trim();
    const password = String(req.body?.password || "");
    const user = store.data.users.find(
      (u) => u.nick.toLowerCase() === nick.toLowerCase(),
    );
    if (!user || !bcrypt.compareSync(password, user.passHash)) {
      return res.status(401).json({ error: "Неверный ник или пароль" });
    }
    setSession(res, user.id, req);
    res.json({ user: publicUser(user) });
  }),
);

app.post("/api/logout", (req, res) => {
  const token = req.cookies?.[COOKIE];
  store.mutate((d) => {
    d.sessions = d.sessions.filter((s) => s.token !== token);
  });
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/me", requireUser, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get("/api/state", requireUser, (req, res) => {
  res.json(snapshot(req.user));
});

app.get("/api/task/:category", requireUser, (req, res) => {
  const category = req.params.category;
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "Нет такой категории" });
  }
  const skipId = req.query.skip ? String(req.query.skip) : null;
  const task = nextTask(req.user, category, skipId);
  res.json({ task: task ? publicVideo(task) : null, credits: req.user.credits });
});

app.post("/api/task/:id/start", requireUser, (req, res) => {
  const video = store.data.videos.find((v) => v.id === req.params.id && v.active);
  if (!video) return res.status(404).json({ error: "Ролик уже не в эфире" });
  if (video.userId === req.user.id) {
    return res.status(400).json({ error: "Своё видео смотреть нельзя" });
  }
  watches.set(req.user.id, {
    videoKey: video.id,
    category: video.category,
    startedAt: now(),
    lastBeat: now(),
    beats: 0,
    openedAt: video.category === "views" ? now() : 0,
  });
  res.json({ ok: true, needMs: WATCH_MS });
});

app.post("/api/task/:id/beat", requireUser, (req, res) => {
  const w = watches.get(req.user.id);
  if (!w || w.videoKey !== req.params.id) {
    return res.status(400).json({ error: "Сначала начни просмотр" });
  }
  w.beats += 1;
  w.lastBeat = now();
  res.json({ ok: true, elapsed: now() - w.startedAt });
});

app.post("/api/task/:id/open", requireUser, (req, res) => {
  const video = store.data.videos.find((v) => v.id === req.params.id && v.active);
  if (!video) return res.status(404).json({ error: "Ролик уже не в эфире" });
  let w = watches.get(req.user.id);
  if (!w || w.videoKey !== video.id) {
    w = {
      videoKey: video.id,
      category: video.category,
      startedAt: now(),
      lastBeat: now(),
      beats: 0,
      openedAt: now(),
    };
    watches.set(req.user.id, w);
  } else {
    w.openedAt = now();
  }
  res.json({ ok: true, gapMs: ACTION_GAP_MS });
});

app.post(
  "/api/task/:id/complete",
  requireUser,
  wrap(async (req, res) => {
    if (!rateLimit(req.user.id + ":done", 40, 60_000)) {
      return res.status(429).json({ error: "Слишком быстро. Чуть помедленнее." });
    }
    const video = store.data.videos.find((v) => v.id === req.params.id && v.active);
    if (!video) return res.status(404).json({ error: "Ролик уже не в эфире" });
    if (video.userId === req.user.id) {
      return res.status(400).json({ error: "Своё видео не засчитывается" });
    }
    const already = store.data.completions.some(
      (c) => c.userId === req.user.id && c.videoKey === video.id,
    );
    if (already) return res.status(400).json({ error: "Это задание ты уже закрыл" });

    const w = watches.get(req.user.id);
    if (!w || w.videoKey !== video.id) {
      return res.status(400).json({ error: "Сначала открой задание" });
    }

    if (video.category === "views") {
      const elapsed = now() - w.startedAt;
      if (elapsed < WATCH_MS - 400) {
        return res.status(400).json({ error: "Смотри не меньше 20 секунд" });
      }
      if (w.beats < 3) {
        return res.status(400).json({ error: "Просмотр прервался. Запусти снова." });
      }
    } else {
      if (!w.openedAt) {
        return res.status(400).json({ error: "Сначала открой ролик на Rutube" });
      }
      if (now() - w.openedAt < ACTION_GAP_MS) {
        return res.status(400).json({ error: "Открой Rutube, сделай действие, затем подтверди" });
      }
    }

    let extra = {};
    if (video.category === "comments") {
      const comment = String(req.body?.comment || "").trim();
      if (comment.length < 12 || comment.length > 400) {
        return res.status(400).json({
          error: "Комментарий: от 12 до 400 символов, как под роликом",
        });
      }
      extra = { comment };
    }

    store.mutate((d) => {
      d.completions.push({
        id: id(),
        userId: req.user.id,
        videoKey: video.id,
        category: video.category,
        at: now(),
        extra,
      });
      const v = d.videos.find((x) => x.id === video.id);
      if (v) v.received += 1;
      const u = d.users.find((x) => x.id === req.user.id);
      if (u) {
        u.credits[video.category] += 1;
        u.stats.done[video.category] += 1;
      }
      if (video.userId !== "studio") {
        const owner = d.users.find((x) => x.id === video.userId);
        if (owner) owner.stats.received[video.category] += 1;
      }
    });
    watches.delete(req.user.id);

    const fresh = store.data.users.find((u) => u.id === req.user.id);
    pushActivity(
      `«${fresh.nick}» ${actionLabel(video.category)} «${video.title}»`,
      video.category,
    );
    broadcast({ type: "stats", stats: globalStats() });

    const next = nextTask(fresh, video.category, null);
    res.json({
      ok: true,
      credits: fresh.credits,
      user: publicUser(fresh),
      next: next ? publicVideo(next) : null,
    });
  }),
);

app.post(
  "/api/preview",
  requireUser,
  wrap(async (req, res) => {
    const parsed = parseRutube(String(req.body?.url || ""));
    if (!parsed) {
      return res.status(400).json({ error: "Нужна ссылка на rutube.ru (видео или канал)" });
    }
    const meta = await fetchMeta(parsed);
    res.json({
      parsed,
      title: meta.title || (parsed.kind === "video" ? "Видео Rutube" : "Канал Rutube"),
      author: meta.author || "",
      thumb: meta.thumb,
      duration: meta.duration,
      channelUrl: meta.channelUrl || parsed.channelUrl || parsed.pageUrl,
      url: parsed.pageUrl || parsed.channelUrl,
      embedUrl: parsed.embedUrl || null,
    });
  }),
);

app.post(
  "/api/publish",
  requireUser,
  wrap(async (req, res) => {
    if (!rateLimit(req.user.id + ":pub", 6, 60_000)) {
      return res.status(429).json({ error: "Подожди секунду перед следующей заявкой" });
    }
    const category = String(req.body?.category || "");
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Выбери категорию" });
    }
    const user = store.data.users.find((u) => u.id === req.user.id);
    if ((user.credits[category] || 0) < COST) {
      return res.status(400).json({
        error: `Нужно ${COST} чужих ${CAT_GEN[category]} — сейчас ${user.credits[category] || 0}`,
      });
    }
    const parsed = parseRutube(String(req.body?.url || ""));
    if (!parsed) {
      return res.status(400).json({ error: "Вставь ссылку на видео с rutube.ru" });
    }
    if (category !== "subs" && parsed.kind !== "video") {
      return res.status(400).json({ error: "Для этой категории нужна ссылка на видео" });
    }
    if (category === "subs" && parsed.kind === "channel") {
      /* ok */
    } else if (parsed.kind !== "video") {
      return res.status(400).json({ error: "Нужна ссылка на видео rutube.ru" });
    }

    const meta = await fetchMeta(parsed);
    const title =
      String(req.body?.title || "").trim().slice(0, 120) ||
      meta.title ||
      (parsed.kind === "video" ? "Видео Rutube" : `Канал ${parsed.id}`);

    const videoId = parsed.kind === "video" ? parsed.id : `ch_${parsed.id}`;
    const url = parsed.pageUrl || parsed.channelUrl;
    const duplicate = store.data.videos.find(
      (v) =>
        v.userId === user.id &&
        v.category === category &&
        v.videoId === videoId &&
        v.active,
    );
    if (duplicate) {
      return res.status(400).json({ error: "Этот ролик уже крутится в этой категории" });
    }

    const record = {
      id: id(),
      userId: user.id,
      category,
      videoId,
      url,
      embedUrl: parsed.embedUrl || null,
      title,
      author: meta.author || user.nick,
      thumb: meta.thumb || (parsed.kind === "video" ? thumbUrl(parsed.id) : null),
      channelUrl: meta.channelUrl || parsed.channelUrl || url,
      createdAt: now(),
      received: 0,
      active: true,
      system: false,
    };

    store.mutate((d) => {
      const u = d.users.find((x) => x.id === user.id);
      u.credits[category] -= COST;
      d.videos.push(record);
    });

    const fresh = store.data.users.find((u) => u.id === user.id);
    pushActivity(`«${fresh.nick}» вышел в эфир · ${CAT_RU[category]}`, "publish");
    broadcast({ type: "stats", stats: globalStats() });
    res.json({ ok: true, video: publicVideo(record), user: publicUser(fresh) });
  }),
);

app.get("/api/mine", requireUser, (req, res) => {
  const mine = store.data.videos
    .filter((v) => v.userId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((v) => {
      const comments = store.data.completions
        .filter((c) => c.videoKey === v.id && c.extra?.comment)
        .slice(-5)
        .map((c) => ({
          text: c.extra.comment,
          at: c.at,
          nick: store.data.users.find((u) => u.id === c.userId)?.nick || "Игрок",
        }));
      return { ...publicVideo(v), active: v.active, createdAt: v.createdAt, comments };
    });
  res.json({ mine });
});

app.post("/api/mine/:id/toggle", requireUser, (req, res) => {
  const video = store.data.videos.find(
    (v) => v.id === req.params.id && v.userId === req.user.id,
  );
  if (!video) return res.status(404).json({ error: "Не найдено" });
  store.mutate((d) => {
    const v = d.videos.find((x) => x.id === video.id);
    v.active = !v.active;
  });
  broadcast({ type: "stats", stats: globalStats() });
  res.json({ ok: true, active: !video.active });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "Rutube Boost" });
});

app.get("/api/public", (_req, res) => {
  res.json({
    online: onlineNicks().length,
    players: store.data.users.length,
    videos: store.data.videos.filter((v) => v.active).length,
    today: todayCount(),
  });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Нет такого метода" });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Студия споткнулась. Попробуй ещё раз." });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function cookieFrom(req) {
  const header = req.headers.cookie || "";
  const parts = header.split(";").map((s) => s.trim());
  for (const p of parts) {
    if (p.startsWith(COOKIE + "=")) return decodeURIComponent(p.slice(COOKIE.length + 1));
  }
  return null;
}

wss.on("connection", (ws, req) => {
  const user = userBySession(cookieFrom(req));
  if (!user) {
    ws.close(4401, "auth");
    return;
  }
  sockets.set(ws, { userId: user.id, nick: user.nick });
  ws.send(
    JSON.stringify({
      type: "hello",
      chat: store.data.chat.slice(-80),
      online: onlineNicks(),
      stats: globalStats(),
    }),
  );
  broadcastPresence();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (msg.type !== "chat") return;
    const text = String(msg.text || "").trim().slice(0, 300);
    if (!text) return;
    if (!rateLimit(user.id + ":chat", 4, 3000)) {
      ws.send(JSON.stringify({ type: "error", error: "Пиши чуть медленнее" }));
      return;
    }
    const item = {
      id: id(),
      userId: user.id,
      nick: user.nick,
      text,
      at: now(),
    };
    store.mutate((d) => {
      d.chat.push(item);
      if (d.chat.length > 250) d.chat = d.chat.slice(-250);
    });
    broadcast({ type: "chat", item });
  });

  ws.on("close", () => {
    sockets.delete(ws);
    broadcastPresence();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Rutube Boost → http://${HOST}:${PORT}`);
});
