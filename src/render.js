// Превращение собранного треда в Markdown, HTML (для PDF), Word и Telegraph.

import { zipStore } from "./zip.js";

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

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
.vid span{font-family:"PT Sans",Arial,sans-serif;font-size:9pt;color:#666}
</style></head><body>
<header><h1>${esc(title(thread))}</h1>
<div class="meta">${esc(m.who)}${m.date ? " · " + esc(m.date) : ""} · твитов: ${m.count}<br><a href="${esc(m.url)}">${esc(m.url)}</a></div></header>
${items}
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
  return nodes;
}
