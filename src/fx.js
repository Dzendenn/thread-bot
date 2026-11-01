// Получение твитов через бесплатный FxTwitter (api.fxtwitter.com).
//
// Порядок сборки треда:
// 1. /2/thread/{id}: развёрнутый тред одним запросом (основной путь).
// 2. Если ниже последнего найденного твита продолжения нет,
//    /2/conversation/{id}: ответы на твит, среди них ищем ответ самого автора.
// 3. Если выше не хватает твитов, поднимаемся по одному через /2/status/{id}.
// Все запросы считаются: на бесплатном Cloudflare их не больше 50 на одно действие.

const FX = "https://api.fxtwitter.com";
const UA = { "User-Agent": "thread-bot/1.1 (personal use)" };

const HOSTS =
  "(?:twitter\\.com|x\\.com|fxtwitter\\.com|fixupx\\.com|vxtwitter\\.com|fixvx\\.com|nitter\\.[a-z.]+)";
const STATUS_RE = new RegExp(
  `${HOSTS}/(?:i/web/|i/|[A-Za-z0-9_]{1,30}/)status(?:es)?/(\\d{5,25})`,
  "i"
);

export function parseStatusId(text) {
  if (!text) return null;
  const m = text.match(STATUS_RE);
  if (m) return m[1];
  const bare = text.trim().match(/^(\d{10,25})$/);
  return bare ? bare[1] : null;
}

export class FxError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Понимает и старый формат FxTwitter (v1), и новый (v2).
export function normalize(t) {
  if (!t || t.type === "tombstone" || !t.id) return null;
  const media = t.media || {};
  const rt = t.replying_to;
  const replyingTo = typeof rt === "string" ? rt : rt?.screen_name || null;
  const replyingToStatus = t.replying_to_status ?? (typeof rt === "object" ? rt?.status : null);
  return {
    id: String(t.id),
    url: t.url || `https://x.com/${t.author?.screen_name}/status/${t.id}`,
    text: t.text || t.raw_text?.text || "",
    ts: t.created_timestamp || null,
    author: {
      name: t.author?.name || "",
      handle: t.author?.screen_name || "",
    },
    replyingTo,
    replyingToStatus: replyingToStatus ? String(replyingToStatus) : null,
    replies: t.replies ?? null,
    likes: t.likes ?? 0,
    photos: (media.photos || []).map((p) => p.url).filter(Boolean),
    videos: (media.videos || [])
      .map((v) => ({ url: v.url, thumb: v.thumbnail_url || null }))
      .filter((v) => v.url),
    quote: t.quote ? normalize(t.quote) : null,
  };
}

// Счётчик запросов на одно действие.
export class Budget {
  constructor(max) {
    this.left = max;
  }
  take() {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }
}

async function fxGet(path, budget) {
  if (budget && !budget.take()) throw new FxError("budget", 0);
  const r = await fetch(`${FX}${path}`, { headers: UA });
  let j = null;
  try {
    j = await r.json();
  } catch {
    /* пусто */
  }
  if (r.status === 404) throw new FxError("not_found", 404);
  if (r.status === 401) throw new FxError("private", 401);
  if (!r.ok || !j) throw new FxError(`http_${r.status}`, r.status);
  return j;
}

// Одиночный твит: сначала v2, при сбое старый v1.
export async function getTweet(id, budget) {
  try {
    const j = await fxGet(`/2/status/${id}`, budget);
    const t = normalize(j.status || j.tweet);
    if (t) return t;
  } catch (e) {
    if (e.status === 404 || e.status === 401 || e.message === "budget") throw e;
  }
  const j = await fxGet(`/status/${id}`, budget);
  if (j.code !== 200 || !j.tweet) throw new FxError(j.message || `code_${j.code}`, j.code);
  return normalize(j.tweet);
}

function sameAuthor(t, handle) {
  return t && t.author.handle.toLowerCase() === handle;
}

export async function collectThread(id, max = 40, budget = new Budget(44)) {
  const pool = new Map(); // id -> твит автора
  let start = null;
  const sources = [];

  // 1. Развёрнутый тред одним запросом
  try {
    const j = await fxGet(`/2/thread/${id}`, budget);
    start = normalize(j.status);
    const items = [j.status, ...(Array.isArray(j.thread) ? j.thread : [])].map(normalize).filter(Boolean);
    if (start) {
      const h = start.author.handle.toLowerCase();
      for (const t of items) if (sameAuthor(t, h)) pool.set(t.id, t);
      sources.push(`thread:${items.length}`);
    }
  } catch (e) {
    if (e.status === 404 || e.status === 401) throw e;
    sources.push(`thread_fail:${e.message}`);
  }

  if (!start) {
    start = await getTweet(id, budget);
    sources.push("status");
  }
  const handle = start.author.handle.toLowerCase();
  pool.set(start.id, start);

  // дети: родитель -> самый ранний ответ автора самому себе
  const childOf = () => {
    const m = new Map();
    for (const t of pool.values()) {
      if (!t.replyingToStatus || t.replyingTo?.toLowerCase() !== handle) continue;
      const prev = m.get(t.replyingToStatus);
      if (!prev || BigInt(t.id) < BigInt(prev.id)) m.set(t.replyingToStatus, t);
    }
    return m;
  };

  // 2. Вверх от присланного твита
  const up = [];
  let cur = start;
  let brokenAt = null;
  let truncated = false;
  while (cur.replyingToStatus && cur.replyingTo?.toLowerCase() === handle) {
    if (up.length + 1 >= max) {
      truncated = true;
      break;
    }
    let parent = pool.get(cur.replyingToStatus);
    if (!parent) {
      try {
        parent = await getTweet(cur.replyingToStatus, budget);
      } catch (e) {
        if (e.message === "budget") truncated = true;
        else brokenAt = cur.replyingToStatus;
        break;
      }
      if (!sameAuthor(parent, handle)) break;
      pool.set(parent.id, parent);
    }
    up.push(parent);
    cur = parent;
  }
  up.reverse();

  // 3. Вниз от присланного твита
  const down = [];
  const seen = new Set([start.id, ...up.map((t) => t.id)]);
  cur = start;
  let downStopped = null;
  while (up.length + 1 + down.length < max) {
    let child = childOf().get(cur.id);
    if (!child) {
      // в развёрнутом треде продолжения нет, спрашиваем ответы на этот твит
      try {
        const j = await fxGet(`/2/conversation/${cur.id}`, budget);
        const items = [...(j.thread || []), ...(j.replies || [])].map(normalize).filter(Boolean);
        for (const t of items) if (sameAuthor(t, handle)) pool.set(t.id, t);
        sources.push(`conv:${items.length}`);
      } catch (e) {
        downStopped = e.message;
        sources.push(`conv_fail:${e.message}`);
        break;
      }
      child = childOf().get(cur.id);
    }
    if (!child || seen.has(child.id)) break;
    seen.add(child.id);
    down.push(child);
    cur = child;
  }
  if (up.length + 1 + down.length >= max) truncated = true;
  if (downStopped === "budget") truncated = true;

  const tweets = [...up, start, ...down];
  return {
    author: start.author,
    tweets,
    lastId: start.id,
    truncated,
    brokenAt,
    downStopped: downStopped && downStopped !== "budget" ? downStopped : null,
    startsAsReplyTo:
      tweets[0].replyingTo && tweets[0].replyingTo.toLowerCase() !== handle ? tweets[0].replyingTo : null,
    sources,
  };
}

// ---------- Обсуждение ----------
// Ответы других людей на первый твит треда: лучшие по лайкам,
// плюс ответы самого автора на эти реплики.

const MENTIONS_RE = /^(?:@\w{1,30}\s+)+/;

export function cleanReply(text) {
  return String(text || "").replace(MENTIONS_RE, "").trim();
}

function meaningful(text) {
  const bare = cleanReply(text)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .trim();
  return bare.length >= 15;
}

export async function collectDiscussion(thread, budget, top = 20) {
  const handle = thread.author.handle.toLowerCase();
  const rootId = thread.tweets[0].id;
  const inThread = new Set(thread.tweets.map((t) => t.id));

  let items = [];
  try {
    const j = await fxGet(`/2/conversation/${rootId}?ranking_mode=likes`, budget);
    items = (j.replies || []).map(normalize).filter(Boolean);
  } catch (e) {
    return { replies: [], error: e.message, total: 0 };
  }

  const others = items.filter(
    (t) => !inThread.has(t.id) && t.author.handle.toLowerCase() !== handle && meaningful(t.text)
  );
  // авторские ответы, пришедшие в той же выдаче
  const authorAnswers = new Map();
  for (const t of items) {
    if (t.author.handle.toLowerCase() === handle && !inThread.has(t.id) && t.replyingToStatus) {
      if (!authorAnswers.has(t.replyingToStatus)) authorAnswers.set(t.replyingToStatus, []);
      authorAnswers.get(t.replyingToStatus).push(t);
    }
  }

  const picked = others.sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, top);

  // для реплик, на которые кто-то отвечал, ищем ответ автора
  for (const r of picked) {
    if (authorAnswers.has(r.id) || !r.replies) continue;
    if (budget.left <= 0) break;
    try {
      const j = await fxGet(`/2/conversation/${r.id}`, budget);
      for (const t of (j.replies || []).map(normalize).filter(Boolean)) {
        if (t.author.handle.toLowerCase() === handle && t.replyingToStatus === r.id) {
          if (!authorAnswers.has(r.id)) authorAnswers.set(r.id, []);
          authorAnswers.get(r.id).push(t);
        }
      }
    } catch {
      /* пропускаем ветку */
    }
  }

  return {
    total: items.length,
    replies: picked.map((r) => ({
      ...r,
      text: cleanReply(r.text),
      authorAnswers: (authorAnswers.get(r.id) || []).map((a) => ({ ...a, text: cleanReply(a.text) })),
    })),
  };
}

// Для служебной страницы /debug: что именно вернул FxTwitter.
export async function debugFx(id) {
  const out = {};
  for (const path of [`/2/thread/${id}`, `/2/conversation/${id}`]) {
    try {
      const r = await fetch(`${FX}${path}`, { headers: UA });
      const j = await r.json().catch(() => null);
      const brief = (t) => {
        const n = normalize(t);
        return n
          ? { id: n.id, by: n.author.handle, re: n.replyingTo, reId: n.replyingToStatus, likes: n.likes, replies: n.replies, text: n.text.slice(0, 50) }
          : { tombstone: t?.reason || true };
      };
      out[path] = {
        http: r.status,
        keys: j ? Object.keys(j) : null,
        status: j?.status ? brief(j.status) : null,
        thread: (j?.thread || []).map(brief),
        replies: (j?.replies || []).slice(0, 15).map(brief),
        cursor: j?.cursor || null,
      };
    } catch (e) {
      out[path] = { error: e.message };
    }
  }
  return out;
}
