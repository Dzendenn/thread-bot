// Обращения к Telegram и Telegraph.

export async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, description: `http ${r.status}` }));
  if (!j.ok) console.log(`tg ${method} failed: ${j.description}`);
  return j;
}

export async function sendDocument(env, chatId, filename, bytes, mime, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append("document", new Blob([bytes], { type: mime }), filename);
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const j = await r.json().catch(() => ({ ok: false, description: `http ${r.status}` }));
  if (!j.ok) console.log(`sendDocument failed: ${j.description}`);
  return j;
}

// Telegraph: страница, которая открывается прямо внутри Telegram.
// Запросы шлём в документированном виде: поля формы, content строкой JSON.
async function telegraphCall(method, fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const r = await fetch(`https://api.telegra.ph/${method}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return r.json().catch(() => ({ ok: false, error: `http_${r.status}` }));
}

async function newTelegraphAccount() {
  const j = await telegraphCall("createAccount", { short_name: "threadbot", author_name: "Thread Bot" });
  if (!j.ok) throw new Error(`telegraph account: ${j.error}`);
  return j.result.access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function telegraphPage(env, title, authorName, authorUrl, nodes) {
  let token = env.TELEGRAPH_TOKEN || (env.THREADS ? await env.THREADS.get("telegraph_token") : null);
  let fresh = false;
  if (!token) {
    token = await newTelegraphAccount();
    fresh = true;
  }
  const fields = {
    title: title.slice(0, 250),
    author_name: authorName.slice(0, 128),
    author_url: authorUrl,
    content: nodes,
  };

  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const j = await telegraphCall("createPage", { access_token: token, ...fields });
    if (j.ok) {
      if (fresh && env.THREADS) await env.THREADS.put("telegraph_token", token);
      return j.result.url;
    }
    last = j.error;
    console.log(`telegraph createPage attempt ${attempt + 1}: ${j.error}`);
    if (j.error !== "ACCOUNT_NOT_FOUND" && j.error !== "ACCESS_TOKEN_INVALID") break;
    // свежий аккаунт иногда не успевает появиться: ждём; сохранённый ключ мог устареть: создаём новый
    if (fresh) await sleep(1500 * (attempt + 1));
    else {
      token = await newTelegraphAccount();
      fresh = true;
    }
  }
  throw new Error(`telegraph page: ${last}`);
}

// PDF через встроенный браузер Cloudflare (бесплатно 10 минут в сутки).
export async function renderPdf(env, html) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) throw new Error("pdf_not_configured");
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/pdf`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CF_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        html,
        gotoOptions: { waitUntil: "networkidle0", timeout: 25000 },
        pdfOptions: {
          format: "a4",
          printBackground: true,
          margin: { top: "16mm", bottom: "16mm", left: "15mm", right: "15mm" },
        },
      }),
    }
  );
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.includes("pdf")) {
    const body = await r.text().catch(() => "");
    const err = new Error(`pdf_${r.status}`);
    err.detail = body.slice(0, 300);
    err.status = r.status;
    throw err;
  }
  return new Uint8Array(await r.arrayBuffer());
}
