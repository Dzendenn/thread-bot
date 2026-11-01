// Проверка без сети: подменяем FxTwitter, Telegram, Telegraph и Cloudflare PDF.
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import worker from "../src/index.js";
import { parseStatusId } from "../src/fx.js";

// ---- разбор ссылок ----
assert.equal(parseStatusId("https://x.com/naval/status/1002103360646823936"), "1002103360646823936");
assert.equal(parseStatusId("смотри https://twitter.com/i/web/status/123456789012?s=20"), "123456789012");
assert.equal(parseStatusId("https://x.com/i/status/1234567890123"), "1234567890123");
assert.equal(parseStatusId("https://fixupx.com/a_b/status/99999999999/photo/1"), "99999999999");
assert.equal(parseStatusId("просто текст"), null);

// ---- тестовый тред из 5 твитов ----
const AUTHOR = { name: "Иван Петров", screen_name: "ivan_p" };
const tweets = {};
for (let i = 1; i <= 5; i++) {
  const id = String(1000000000000 + i);
  tweets[id] = {
    id,
    url: `https://x.com/ivan_p/status/${id}`,
    text:
      i === 1
        ? "Тред о том, почему упаковка дорожает. & <теги> \"кавычки\"\nВторая строка https://example.com/a?b=1"
        : `Пункт ${i}. Текст с переносом\nи продолжением.`,
    created_timestamp: 1767225600 + i * 60,
    author: AUTHOR,
    replying_to: i === 1 ? null : "ivan_p",
    replying_to_status: i === 1 ? null : String(1000000000000 + i - 1),
    replies: 3,
    media:
      i === 2
        ? { photos: [{ url: "https://pbs.twimg.com/media/test.jpg" }] }
        : i === 3
        ? { videos: [{ url: "https://video.twimg.com/v.mp4", thumbnail_url: "https://pbs.twimg.com/t.jpg" }] }
        : {},
    quote:
      i === 4
        ? { id: "77", url: "https://x.com/other/status/77", text: "Чужая цитата", author: { name: "Другой", screen_name: "other" } }
        : null,
  };
}

const sent = [];
let fxCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://api.fxtwitter.com/status/")) {
    fxCalls++;
    const id = url.split("/").pop();
    if (!tweets[id]) return new Response("{}", { status: 404 });
    return Response.json({ code: 200, message: "OK", tweet: tweets[id] });
  }
  if (url.startsWith("https://api.telegram.org/")) {
    const method = url.split("/").pop();
    let body;
    if (init.body instanceof FormData) {
      const doc = init.body.get("document");
      body = { name: doc.name, bytes: new Uint8Array(await doc.arrayBuffer()), caption: init.body.get("caption") };
    } else body = JSON.parse(init.body);
    sent.push({ method, body });
    return Response.json({ ok: true, result: { message_id: 555 } });
  }
  if (url.startsWith("https://api.telegra.ph/createAccount"))
    return Response.json({ ok: true, result: { access_token: "TOKEN" } });
  if (url.startsWith("https://api.telegra.ph/createPage")) {
    const b = JSON.parse(init.body);
    assert.ok(Array.isArray(b.content) && b.content.length > 5);
    assert.ok(JSON.stringify(b).length < 64000);
    return Response.json({ ok: true, result: { url: "https://telegra.ph/test-11-01" } });
  }
  if (url.includes("/browser-rendering/pdf")) {
    const b = JSON.parse(init.body);
    mkdirSync("test/out", { recursive: true });
    writeFileSync("test/out/thread.html", b.html);
    return new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } });
  }
  throw new Error("unexpected fetch " + url);
};

const kv = new Map();
const env = {
  BOT_TOKEN: "1:abc",
  WEBHOOK_SECRET: "s3cret",
  ALLOWED_USER_ID: "42",
  CF_ACCOUNT_ID: "acc",
  CF_API_TOKEN: "tok",
  THREADS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
};

async function call(update, e = env) {
  const pending = [];
  const res = await worker.fetch(
    new Request("https://thread-bot.example.workers.dev/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": e.WEBHOOK_SECRET || "" },
      body: JSON.stringify(update),
    }),
    e,
    { waitUntil: (p) => pending.push(p) }
  );
  await Promise.all(pending);
  return res;
}

// чужой секрет не пускаем
const bad = await worker.fetch(
  new Request("https://w/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "x" }, body: "{}" }),
  env,
  { waitUntil() {} }
);
assert.equal(bad.status, 403);

// чужой пользователь: тишина
await call({ message: { message_id: 1, chat: { id: 7 }, from: { id: 7 }, text: "https://x.com/ivan_p/status/1000000000005" } });
assert.equal(sent.length, 0);

// без ALLOWED_USER_ID: подсказка с номером
await call({ message: { message_id: 1, chat: { id: 7 }, from: { id: 7 }, text: "hi" } }, { ...env, ALLOWED_USER_ID: "" });
assert.match(sent.pop().body.text, /Ваш номер в Telegram: 7/);

// ссылка на последний твит
await call({ message: { message_id: 2, chat: { id: 42 }, from: { id: 42 }, text: "https://x.com/ivan_p/status/1000000000005?s=46" } });
assert.equal(fxCalls, 5);
const summary = sent.find((s) => s.method === "editMessageText");
assert.match(summary.body.text, /Твитов: 5/);
assert.equal(summary.body.reply_markup.inline_keyboard[0].length, 3);
assert.ok(kv.has("t:1000000000005"));

// кнопки
const outDir = "test/out";
mkdirSync(outDir, { recursive: true });
for (const fmt of ["md", "docx", "pdf", "tgph"]) {
  sent.length = 0;
  await call({ callback_query: { id: "c", from: { id: 42 }, message: { chat: { id: 42 } }, data: `${fmt}:1000000000005` } });
  const doc = sent.find((s) => s.method === "sendDocument");
  if (fmt === "tgph") {
    assert.equal(sent.find((s) => s.method === "sendMessage").body.text, "https://telegra.ph/test-11-01");
    continue;
  }
  assert.ok(doc, "no document for " + fmt);
  writeFileSync(`${outDir}/${doc.body.name}`, doc.body.bytes);
  console.log("ok", fmt, doc.body.name, doc.body.bytes.length, "bytes");
}
assert.equal(fxCalls, 5, "кнопки должны брать тред из хранилища, а не скачивать заново");

// без хранилища тред скачивается заново, и это тоже работает
sent.length = 0;
await call({ callback_query: { id: "c", from: { id: 42 }, message: { chat: { id: 42 } }, data: "md:1000000000003" } }, { ...env, THREADS: undefined });
assert.ok(sent.find((s) => s.method === "sendDocument"));

console.log("все проверки прошли");
