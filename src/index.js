// Бот: присылаешь ссылку на твит, получаешь тред в Markdown, PDF, Word или Telegraph.
// Работает целиком на Cloudflare, российский сервер не участвует.

import { parseStatusId, collectThread, collectDiscussion, FxError, Budget, debugFx } from "./fx.js";
import { toMarkdown, toHtml, toDocx, toTelegraphNodes, fileBase, title, esc } from "./render.js";
import { tg, sendDocument, telegraphPage, renderPdf } from "./telegram.js";

const MAX_TWEETS = 40; // запас до лимита в 50 внешних запросов на бесплатном тарифе
const TTL = 7 * 24 * 3600; // сколько хранить собранный тред

const HELP =
  "Пришлите ссылку на твит из X. Лучше всего ссылку на последний твит треда: " +
  "бот соберёт тред от него к началу и предложит выгрузку в Markdown, PDF, Word или Telegraph.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Разовое включение: открыть в браузере /setup?key=WEBHOOK_SECRET
    if (url.pathname === "/setup") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const res = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
      await tg(env, "setMyCommands", {
        commands: [{ command: "start", description: "Как пользоваться" }],
      });
      return Response.json({ setWebhook: res, kv: Boolean(env.THREADS) });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const update = await request.json();
      ctx.waitUntil(handle(update, env).catch((e) => console.log("handle error", e.stack || e)));
      return new Response("ok");
    }

    // Служебная страница: /debug?key=WEBHOOK_SECRET&id=ID_твита
    if (url.pathname === "/debug") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const id = parseStatusId(url.searchParams.get("id") || "");
      if (!id) return new Response("нужен id", { status: 400 });
      const raw = await debugFx(id);
      let collected;
      try {
        const t = await collectThread(id, MAX_TWEETS);
        collected = { count: t.tweets.length, ids: t.tweets.map((x) => x.id), sources: t.sources, truncated: t.truncated, downStopped: t.downStopped };
      } catch (e) {
        collected = { error: e.message };
      }
      return Response.json({ collected, raw }, { headers: { "content-type": "application/json; charset=utf-8" } });
    }

    return new Response("thread-bot работает");
  },
};

function allowed(env, userId) {
  return env.ALLOWED_USER_ID && String(userId) === String(env.ALLOWED_USER_ID).trim();
}

async function handle(update, env) {
  if (update.message) return onMessage(update.message, env);
  if (update.callback_query) return onCallback(update.callback_query, env);
}

async function onMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!env.ALLOWED_USER_ID) {
    // Первый запуск: подсказываем номер, который надо вписать в ALLOWED_USER_ID
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: `Ваш номер в Telegram: ${userId}\nВпишите его в настройку ALLOWED_USER_ID на Cloudflare.`,
    });
  }
  if (!allowed(env, userId)) return; // чужим не отвечаем

  const text = msg.text || msg.caption || "";
  if (text.startsWith("/start") || text.startsWith("/help")) {
    return tg(env, "sendMessage", { chat_id: chatId, text: HELP });
  }

  const id = parseStatusId(text);
  if (!id) return tg(env, "sendMessage", { chat_id: chatId, text: HELP });

  const wait = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "Собираю тред...",
    reply_to_message_id: msg.message_id,
  });
  const waitId = wait.result?.message_id;

  let thread;
  try {
    thread = await collectThread(id, MAX_TWEETS);
  } catch (e) {
    return edit(env, chatId, waitId, fxErrorText(e));
  }

  if (env.THREADS) {
    await env.THREADS.put(`t:${id}`, JSON.stringify(thread), { expirationTtl: TTL });
  }

  const notes = [];
  if (thread.truncated)
    notes.push(`Собрано ${MAX_TWEETS} твитов, до начала треда не дошли: тред длиннее лимита.`);
  if (thread.brokenAt) notes.push("Один из твитов выше удалён или недоступен, начало треда может не попасть.");
  if (thread.startsAsReplyTo) notes.push(`Тред начинается как ответ @${thread.startsAsReplyTo}.`);
  if (thread.downStopped)
    notes.push("Продолжение ниже не удалось проверить до конца. Если тред длиннее, пришлите ссылку на последний твит.");
  else if (thread.tweets.length === 1 && thread.tweets[0].replies)
    notes.push("Продолжения от автора не нашлось. Если тред всё же длиннее, пришлите ссылку на последний твит.");

  const preview = thread.tweets[0].text.replace(/\s+/g, " ").slice(0, 200);
  const body =
    `<b>${esc(thread.author.name)}</b> @${esc(thread.author.handle)}\n` +
    `Твитов: ${thread.tweets.length}\n\n${esc(preview)}${preview.length >= 200 ? "..." : ""}` +
    (notes.length ? `\n\n${esc(notes.join("\n"))}` : "") +
    `\n\nВ каком виде выгрузить?`;

  return edit(env, chatId, waitId, body, { parse_mode: "HTML", reply_markup: keyboard(id, false) });
}

// withD: выгрузка вместе с обсуждением
function keyboard(id, withD) {
  const s = withD ? ":d" : "";
  const plus = withD ? " + ответы" : "";
  return {
    inline_keyboard: [
      [
        { text: `Markdown${plus}`, callback_data: `md:${id}${s}` },
        { text: `PDF${plus}`, callback_data: `pdf:${id}${s}` },
        { text: `Word${plus}`, callback_data: `docx:${id}${s}` },
      ],
      [{ text: `Читать в Telegram${plus}`, callback_data: `tgph:${id}${s}` }],
      [
        withD
          ? { text: "Без обсуждения", callback_data: `tog:${id}` }
          : { text: "Добавить обсуждение (ответы)", callback_data: `tog:${id}:d` },
      ],
    ],
  };
}

async function onCallback(cb, env) {
  const chatId = cb.message?.chat?.id;
  if (!allowed(env, cb.from.id) || !chatId) {
    return tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  }
  const [fmt, id, flag] = String(cb.data || "").split(":");
  const withD = flag === "d";

  // переключатель режима: только меняем кнопки
  if (fmt === "tog") {
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: withD ? "Выгрузка вместе с обсуждением" : "Выгрузка только треда",
    });
    return tg(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      reply_markup: keyboard(id, withD),
    });
  }

  await tg(env, "answerCallbackQuery", {
    callback_query_id: cb.id,
    text: withD ? "Собираю тред и обсуждение..." : "Готовлю...",
  });
  // внешних запросов на одно действие не больше 50, часть уйдёт на Telegram
  const budget = new Budget(42);

  let thread = null;
  if (env.THREADS) {
    const raw = await env.THREADS.get(`t:${id}`);
    if (raw) thread = JSON.parse(raw);
  }
  if (!thread) {
    try {
      thread = await collectThread(id, MAX_TWEETS, budget);
    } catch (e) {
      return tg(env, "sendMessage", { chat_id: chatId, text: fxErrorText(e) });
    }
  }

  if (withD) {
    let disc = null;
    if (env.THREADS) {
      const raw = await env.THREADS.get(`d:${id}`);
      if (raw) disc = JSON.parse(raw);
    }
    if (!disc) {
      disc = await collectDiscussion(thread, budget);
      if (env.THREADS && !disc.error)
        await env.THREADS.put(`d:${id}`, JSON.stringify(disc), { expirationTtl: 24 * 3600 });
    }
    if (disc.error || !disc.replies.length) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: disc.error
          ? `Обсуждение получить не удалось (${disc.error}), выгружаю только тред.`
          : "Содержательных ответов не нашлось, выгружаю только тред.",
      });
    }
    thread = { ...thread, discussion: disc };
  }

  const base = fileBase(thread) + (withD && thread.discussion?.replies?.length ? "_discussion" : "");
  const caption = `${title(thread)}\n${thread.tweets[0].url}`;

  try {
    if (fmt === "md") {
      await tg(env, "sendChatAction", { chat_id: chatId, action: "upload_document" });
      return sendDocument(env, chatId, `${base}.md`, new TextEncoder().encode(toMarkdown(thread)), "text/markdown", caption);
    }
    if (fmt === "docx") {
      await tg(env, "sendChatAction", { chat_id: chatId, action: "upload_document" });
      return sendDocument(
        env, chatId, `${base}.docx`, toDocx(thread),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", caption
      );
    }
    if (fmt === "pdf") {
      await tg(env, "sendChatAction", { chat_id: chatId, action: "upload_document" });
      const pdf = await renderPdf(env, toHtml(thread));
      return sendDocument(env, chatId, `${base}.pdf`, pdf, "application/pdf", caption);
    }
    if (fmt === "tgph") {
      const url = await telegraphPage(
        env, title(thread), `${thread.author.name} @${thread.author.handle}`,
        thread.tweets[0].url, toTelegraphNodes(thread)
      );
      return tg(env, "sendMessage", { chat_id: chatId, text: url });
    }
  } catch (e) {
    console.log("export error", fmt, e.message, e.detail || "");
    return tg(env, "sendMessage", { chat_id: chatId, text: exportErrorText(fmt, e) });
  }
}

function edit(env, chatId, messageId, text, extra = {}) {
  if (!messageId) return tg(env, "sendMessage", { chat_id: chatId, text, ...extra });
  return tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });
}

function fxErrorText(e) {
  if (e instanceof FxError && e.status === 404)
    return "Твит не найден: удалён, закрыт или аккаунт приватный.";
  if (e instanceof FxError && (e.status === 403 || e.status === 429))
    return `FxTwitter отказал в доступе (код ${e.status}). Возможно, он блокирует адреса Cloudflare. Попробуйте позже.`;
  return `Не удалось получить тред: ${e.message}`;
}

function exportErrorText(fmt, e) {
  if (fmt === "pdf" && e.message === "pdf_not_configured")
    return "PDF не настроен: на Cloudflare не заданы CF_ACCOUNT_ID и CF_API_TOKEN.";
  if (fmt === "pdf" && e.status === 429)
    return "Дневной лимит PDF на бесплатном Cloudflare исчерпан (10 минут работы браузера в сутки). Markdown и Word работают.";
  if (fmt === "pdf") return `Не удалось сделать PDF (${e.message}). Подробности в логах Cloudflare.`;
  return `Не удалось сделать файл: ${e.message}`;
}
