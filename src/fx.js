// Получение твитов через бесплатный FxTwitter (api.fxtwitter.com).
// Тред собирается снизу вверх: от присланного твита к началу,
// пока автор отвечает сам себе.

const FX = "https://api.fxtwitter.com";

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

export function normalize(t) {
  if (!t) return null;
  const media = t.media || {};
  return {
    id: String(t.id),
    url: t.url || `https://x.com/${t.author?.screen_name}/status/${t.id}`,
    text: t.text || "",
    ts: t.created_timestamp || null,
    author: {
      name: t.author?.name || "",
      handle: t.author?.screen_name || "",
    },
    replyingTo: t.replying_to || null,
    replyingToStatus: t.replying_to_status ? String(t.replying_to_status) : null,
    replies: t.replies ?? null,
    photos: (media.photos || []).map((p) => p.url).filter(Boolean),
    videos: (media.videos || [])
      .map((v) => ({ url: v.url, thumb: v.thumbnail_url || null }))
      .filter((v) => v.url),
    quote: t.quote ? normalize(t.quote) : null,
  };
}

export async function getTweet(id) {
  const r = await fetch(`${FX}/status/${id}`, {
    headers: { "User-Agent": "thread-bot/1.0 (personal use)" },
  });
  if (r.status === 404) throw new FxError("not_found", 404);
  if (!r.ok) throw new FxError(`http_${r.status}`, r.status);
  let j;
  try {
    j = await r.json();
  } catch {
    throw new FxError("bad_json", 502);
  }
  if (j.code !== 200 || !j.tweet) throw new FxError(j.message || `code_${j.code}`, j.code);
  return normalize(j.tweet);
}

// Собирает тред от твита id вверх. max ограничивает число запросов:
// на бесплатном Cloudflare их не больше 50 за один вызов.
export async function collectThread(id, max = 40) {
  const start = await getTweet(id);
  const handle = start.author.handle.toLowerCase();
  const chain = [start];
  let cur = start;
  let truncated = false;
  let brokenAt = null;

  while (
    cur.replyingToStatus &&
    cur.replyingTo &&
    cur.replyingTo.toLowerCase() === handle
  ) {
    if (chain.length >= max) {
      truncated = true;
      break;
    }
    try {
      cur = await getTweet(cur.replyingToStatus);
    } catch (e) {
      brokenAt = cur.replyingToStatus;
      break;
    }
    chain.push(cur);
  }

  chain.reverse();
  return {
    author: start.author,
    tweets: chain,
    lastId: start.id,
    truncated, // упёрлись в лимит, начало треда не достали
    brokenAt, // промежуточный твит удалён или недоступен
    // первый твит сам является ответом другому человеку
    startsAsReplyTo:
      chain[0].replyingTo && chain[0].replyingTo.toLowerCase() !== handle
        ? chain[0].replyingTo
        : null,
  };
}
