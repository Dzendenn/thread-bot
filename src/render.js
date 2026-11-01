// Превращение собранного треда в Markdown, HTML (для PDF), Word и Telegraph.

import { zipStore } from "./zip.js";

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  const w = a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  return `${n} ${w}`;
}
const likes = (n) => plural(n || 0, "лайк", "лайка", "лайков");
const best = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "лучший ответ" : "лучших ответов"} по лайкам`;

export function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function fileBase(thread) {
  const h = (thread.author.handle || "thread").replace(/[^A-Za-z0-9_]/g, "");
  return `thread_${h}_${thread.tweets[0].id}`;
}

export function title(thread) {
  const first = (thread.tweets[0].text.split("\n").find((l) => l.trim()) || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const head = first.length > 80 ? first.slice(0, 77).trimEnd() + "..." : first;
  return head || `Тред @${thread.author.handle}`;
}

function meta(thread) {
  return {
    who: `${thread.author.name} (@${thread.author.handle})`,
    date: fmtDate(thread.tweets[0].ts),
    count: thread.tweets.length,
    url: thread.tweets[0].url,
  };
}

// ---------- Markdown ----------

export function toMarkdown(thread) {
  const m = meta(thread);
  const out = [];
  out.push(`# ${title(thread)}`, "");
  out.push(`Автор: ${m.who}  `);
  if (m.date) out.push(`Дата: ${m.date}  `);
  out.push(`Твитов: ${m.count}  `);
  out.push(`Источник: ${m.url}`, "", "---", "");

  thread.tweets.forEach((t, i) => {
    out.push(`**${i + 1}/${m.count}**`, "");
    out.push(t.text.trim(), "");
    for (const p of t.photos) out.push(`![](${p})`, "");
    for (const v of t.videos) out.push(`[Видео](${v.url})`, "");
    if (t.quote) {
      const q = t.quote;
      out.push(`> Цитата: ${q.author.name} (@${q.author.handle})`);
      for (const line of q.text.split("\n")) out.push(`> ${line}`);
      out.push(`> ${q.url}`, "");
    }
  });
  if (thread.discussion?.replies?.length) {
    out.push("---", "", `## Обсуждение (${best(thread.discussion.replies.length)})`, "");
    for (const r of thread.discussion.replies) {
      out.push(`**${r.author.name}** @${r.author.handle} · ${likes(r.likes)}`, "");
      out.push(r.text, "");
      for (const p of r.photos) out.push(`![](${p})`, "");
      for (const a of r.authorAnswers) {
        out.push(`> **Автор:** ${a.text.split("\n").join("\n> ")}`, "");
      }
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

// ---------- HTML (основа для PDF) ----------

export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linkify(s) {
  return esc(s)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, "<br>");
}

function discussionHtml(thread) {
  const d = thread.discussion;
  if (!d?.replies?.length) return "";
  const rows = d.replies
    .map((r) => {
      const ans = r.authorAnswers
        .map((a) => `<blockquote class="author"><b>Автор:</b> ${linkify(a.text)}</blockquote>`)
        .join("");
      const photos = r.photos.map((p) => `<img src="${esc(p)}">`).join("");
      return `<div class="reply"><div class="who"><b>${esc(r.author.name)}</b> @${esc(r.author.handle)} · ${likes(r.likes)}</div><p>${linkify(r.text)}</p>${photos}${ans}</div>`;
    })
    .join("\n");
  return `<h2>Обсуждение</h2><div class="meta">${best(d.replies.length)}</div>${rows}`;
}

export function toHtml(thread) {
  const m = meta(thread);
  const items = thread.tweets
    .map((t, i) => {
      const photos = t.photos.map((p) => `<img src="${esc(p)}">`).join("");
      const videos = t.videos
        .map((v) =>
          v.thumb
            ? `<a class="vid" href="${esc(v.url)}"><img src="${esc(v.thumb)}"><span>Видео</span></a>`
            : `<p><a href="${esc(v.url)}">Видео</a></p>`
        )
        .join("");
      const quote = t.quote
        ? `<blockquote><b>${esc(t.quote.author.name)}</b> @${esc(t.quote.author.handle)}<br>${linkify(t.quote.text)}</blockquote>`
        : "";
      return `<section><div class="n">${i + 1}/${m.count}</div><p>${linkify(t.text.trim())}</p>${photos}${videos}${quote}</section>`;
    })
    .join("\n");

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=PT+Serif:ital,wght@0,400;0,700;1,400&family=PT+Sans:wght@400;700&display=swap" rel="stylesheet">
<style>
body{font-family:"PT Serif",Georgia,serif;font-size:12pt;line-height:1.55;color:#1b1b1b;margin:0}
header{font-family:"PT Sans",Arial,sans-serif;border-bottom:1px solid #ccc;padding-bottom:10px;margin-bottom:18px}
h1{font-size:18pt;margin:0 0 6px}
.meta{color:#666;font-size:10pt}
.meta a{color:#666}
section{page-break-inside:auto;margin:0 0 16px;padding-bottom:12px;border-bottom:1px solid #eee}
.n{font-family:"PT Sans",Arial,sans-serif;color:#999;font-size:9pt;margin-bottom:2px}
p{margin:0 0 8px;white-space:normal;word-wrap:break-word}
img{max-width:100%;max-height:520px;display:block;margin:8px 0;border-radius:6px;page-break-inside:avoid}
blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid #bbb;background:#f6f6f6;font-size:11pt}
a{color:#1d5fa8;text-decoration:none;word-break:break-all}
.vid{display:block;position:relative}
h2{font-family:"PT Sans",Arial,sans-serif;font-size:15pt;margin:28px 0 4px}
.reply{margin:12px 0;padding:0 0 10px 12px;border-left:2px solid #e2e2e2;font-size:11pt}
.who{font-family:"PT Sans",Arial,sans-serif;font-size:9.5pt;color:#555;margin-bottom:2px}
blockquote.author{background:#eef4fb;border-left-color:#1d5fa8}
.vid span{font-family:"PT Sans",Arial,sans-serif;font-size:9pt;color:#666}
</style></head><body>
<header><h1>${esc(title(thread))}</h1>
<div class="meta">${esc(m.who)}${m.date ? " · " + esc(m.date) : ""} · твитов: ${m.count}<br><a href="${esc(m.url)}">${esc(m.url)}</a></div></header>
${items}
${discussionHtml(thread)}
</body></html>`;
}

// ---------- Word (.docx) ----------

function x(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // убираем управляющие символы, которые ломают XML
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function run(text, { bold = false, italic = false, size = null, color = null } = {}) {
  const props = [
    bold ? "<w:b/>" : "",
    italic ? "<w:i/>" : "",
    color ? `<w:color w:val="${color}"/>` : "",
    size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : "",
  ].join("");
  const lines = String(text).split("\n");
  const body = lines
    .map((l, i) => (i ? "<w:br/>" : "") + `<w:t xml:space="preserve">${x(l)}</w:t>`)
    .join("");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${body}</w:r>`;
}

function para(runs, { indent = 0, after = 120, shade = null } = {}) {
  const ppr = [
    `<w:spacing w:after="${after}"/>`,
    indent ? `<w:ind w:left="${indent}"/>` : "",
    shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : "",
  ].join("");
  return `<w:p><w:pPr>${ppr}</w:pPr>${runs}</w:p>`;
}

export function toDocx(thread) {
  const m = meta(thread);
  const ps = [];
  ps.push(para(run(title(thread), { bold: true, size: 32 }), { after: 80 }));
  ps.push(
    para(
      run(`${m.who}${m.date ? ", " + m.date : ""}, твитов: ${m.count}\n${m.url}`, {
        size: 18,
        color: "666666",
      }),
      { after: 240 }
    )
  );
  thread.tweets.forEach((t, i) => {
    ps.push(para(run(`${i + 1}/${m.count}`, { size: 16, color: "999999" }), { after: 40 }));
    ps.push(para(run(t.text.trim(), { size: 22 })));
    for (const p of t.photos) ps.push(para(run(`[Картинка] ${p}`, { size: 18, color: "1D5FA8" })));
    for (const v of t.videos) ps.push(para(run(`[Видео] ${v.url}`, { size: 18, color: "1D5FA8" })));
    if (t.quote) {
      ps.push(
        para(
          run(`${t.quote.author.name} @${t.quote.author.handle}\n`, { bold: true, size: 20 }) +
            run(`${t.quote.text}\n${t.quote.url}`, { italic: true, size: 20 }),
          { indent: 360, shade: "F2F2F2" }
        )
      );
    }
    ps.push(para("", { after: 120 }));
  });

  if (thread.discussion?.replies?.length) {
    ps.push(para(run("Обсуждение", { bold: true, size: 28 }), { after: 60 }));
    ps.push(para(run(best(thread.discussion.replies.length), { size: 18, color: "666666" }), { after: 200 }));
    for (const r of thread.discussion.replies) {
      ps.push(para(run(`${r.author.name} @${r.author.handle}, ${likes(r.likes)}`, { bold: true, size: 18, color: "555555" }), { after: 20, indent: 240 }));
      ps.push(para(run(r.text, { size: 21 }), { indent: 240 }));
      for (const a of r.authorAnswers) {
        ps.push(para(run("Автор: ", { bold: true, size: 20 }) + run(a.text, { size: 20 }), { indent: 600, shade: "EEF4FB" }));
      }
    }
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${ps.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia" w:eastAsia="Georgia"/><w:sz w:val="22"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  return zipStore([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "word/document.xml", data: document },
    { name: "word/styles.xml", data: styles },
    { name: "word/_rels/document.xml.rels", data: docRels },
  ]);
}

// ---------- Telegraph ----------

function textNodes(s) {
  const out = [];
  String(s)
    .split("\n")
    .forEach((line, i) => {
      if (i) out.push({ tag: "br" });
      // ссылки делаем кликабельными
      const parts = line.split(/(https?:\/\/\S+)/g);
      for (const p of parts) {
        if (!p) continue;
        if (/^https?:\/\//.test(p)) out.push({ tag: "a", attrs: { href: p }, children: [p] });
        else out.push(p);
      }
    });
  return out;
}

export function toTelegraphNodes(thread) {
  const m = meta(thread);
  const nodes = [
    {
      tag: "p",
      children: [
        { tag: "i", children: [`${m.who}${m.date ? ", " + m.date : ""}, твитов: ${m.count}. `] },
        { tag: "a", attrs: { href: m.url }, children: ["Оригинал"] },
      ],
    },
  ];
  thread.tweets.forEach((t, i) => {
    if (i) nodes.push({ tag: "hr" });
    nodes.push({ tag: "p", children: textNodes(t.text.trim()) });
    for (const p of t.photos)
      nodes.push({ tag: "figure", children: [{ tag: "img", attrs: { src: p } }] });
    for (const v of t.videos)
      nodes.push({ tag: "p", children: [{ tag: "a", attrs: { href: v.url }, children: ["Видео"] }] });
    if (t.quote) {
      nodes.push({
        tag: "blockquote",
        children: [
          { tag: "b", children: [`${t.quote.author.name} @${t.quote.author.handle}`] },
          { tag: "br" },
          ...textNodes(t.quote.text),
        ],
      });
    }
  });
  if (thread.discussion?.replies?.length) {
    nodes.push({ tag: "hr" });
    nodes.push({ tag: "h3", children: ["Обсуждение"] });
    for (const r of thread.discussion.replies) {
      nodes.push({
        tag: "p",
        children: [{ tag: "b", children: [`${r.author.name} @${r.author.handle}`] }, ` · ${likes(r.likes)}`, { tag: "br" }, ...textNodes(r.text)],
      });
      for (const a of r.authorAnswers)
        nodes.push({ tag: "blockquote", children: [{ tag: "b", children: ["Автор: "] }, ...textNodes(a.text)] });
    }
  }
  return nodes;
}
