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
async function telegraphToken(env) {
  if (env.TELEGRAPH_TOKEN) return env.TELEGRAPH_TOKEN;
  if (env.THREADS) {
    const saved = await env.THREADS.get("telegraph_token");
    if (saved) return saved;
  }
  const r = await fetch("https://api.telegra.ph/createAccount", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ short_name: "thread-bot", author_name: "Thread Bot" }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegraph account: ${j.error}`);
  if (env.THREADS) await env.THREADS.put("telegraph_token", j.result.access_token);
  return j.result.access_token;
}

export async function telegraphPage(env, title, authorName, authorUrl, nodes) {
  const token = await telegraphToken(env);
  const r = await fetch("https://api.telegra.ph/createPage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      access_token: token,
      title: title.slice(0, 250),
      author_name: authorName.slice(0, 128),
      author_url: authorUrl,
      content: nodes,
    }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegraph page: ${j.error}`);
  return j.result.url;
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
