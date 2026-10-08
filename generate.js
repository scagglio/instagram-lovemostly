// generate.js  (Love, Mostly single-image version)
//
// Headless content generation for @love.mostly:
//   1. Picks a pillar (sweet / funny / spicy / motivational) based on the time of day,
//      using the weighted slots in account.json, and never the same pillar twice in a row
//   2. Asks Claude for one original quote, an optional kicker, a caption and alt text
//   3. Runs local checks, then a second Claude call that reviews the draft against the rules.
//      Rejected drafts are retried with the reviewer's feedback.
//   4. Renders a 1080x1350 JPEG in the brand style (or, every Nth post, a photo post when an
//      Unsplash key is set)
//   5. Writes post.json for publish.js
//
// Environment:
//   ANTHROPIC_API_KEY      required
//   DRY_RUN                "true" writes to drafts/ instead of images/
//   PILLAR                 optional, force a pillar (sweet, funny, spicy, motivational)
//   FORCE_PHOTO            optional, "true" makes this a photo post (needs UNSPLASH_ACCESS_KEY)
//   UNSPLASH_ACCESS_KEY    optional, enables occasional photo posts

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const account = require("./account.json");

const DRY_RUN = process.env.DRY_RUN === "true";
const HISTORY_PATH = path.join(__dirname, "history.json");
const PILLARS = Object.keys(account.pillars);

function loadHistory() {
  return fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) : [];
}

// ---------- Choosing what to post ----------

function slotFor(date) {
  const h = date.getUTCHours();
  for (const s of account.slots) {
    const inSlot = s.fromHourUTC <= s.toHourUTC ? h >= s.fromHourUTC && h < s.toHourUTC : h >= s.fromHourUTC || h < s.toHourUTC;
    if (inSlot) return s;
  }
  return account.slots[0];
}

function weightedPick(weights, exclude) {
  const entries = Object.entries(weights).filter(([k, w]) => k !== exclude && w > 0 && account.pillars[k]);
  const pool = entries.length ? entries : PILLARS.filter((p) => p !== exclude).map((p) => [p, 1]);
  const total = pool.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of pool) {
    if ((r -= w) < 0) return k;
  }
  return pool[pool.length - 1][0];
}

function choosePillar(history) {
  const forced = (process.env.PILLAR || "").trim().toLowerCase();
  if (forced && forced !== "auto") {
    if (!account.pillars[forced]) throw new Error(`Unknown PILLAR "${forced}". Use one of: ${PILLARS.join(", ")}`);
    return { pillar: forced, slot: "manual" };
  }
  const slot = slotFor(new Date());
  const last = history.length ? history[history.length - 1].pillar : null;
  return { pillar: weightedPick(slot.weights, last), slot: slot.name };
}

function wantsPhoto(history) {
  if (!process.env.UNSPLASH_ACCESS_KEY) return false;
  if (process.env.FORCE_PHOTO === "true") return true;
  const n = Number(account.photo && account.photo.everyNthPost) || 0;
  if (n < 2) return false;
  if (DRY_RUN) return Math.random() < 1 / n;
  return history.length % n === n - 1;
}

// ---------- Claude ----------

class ParseError extends Error {}

async function callClaude(system, user, maxTokens = 800) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: account.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function parseJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ParseError("No JSON object found in the response");
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new ParseError(`Invalid JSON: ${err.message}`);
  }
}

const list = (items) => (items || []).map((r) => `- ${r}`).join("\n") || "- (none)";

function briefText() {
  return [
    `Handle: ${account.handle}`,
    `Niche: ${account.niche}`,
    `Audience: ${account.audience}`,
    `Voice: ${account.voice}`,
    `Rules:\n${list(account.rules)}`,
    `Never post about:\n${list(account.bannedTopics)}`,
  ].join("\n\n");
}

async function draftPost(pillar, photo, history, feedback) {
  const recent = history.slice(-60).map((h) => `- ${h.quote || h.headline}`).join("\n") || "(none yet)";
  const p = account.pillars[pillar];

  const system =
    `You write an Instagram quote account with no human editor, so every post must be safe to publish exactly as written.\n\n` +
    briefText();

  const user =
    `Write the next single-image post.\n` +
    `Pillar: ${p.label}\n` +
    `Pillar guidance: ${p.guidance}\n` +
    `Today's date: ${new Date().toISOString().slice(0, 10)}\n\n` +
    `Recent quotes (do not repeat, closely paraphrase, or reuse the same joke or structure):\n${recent}\n` +
    (feedback ? `\nYour previous draft was rejected. Reason: ${feedback}\nFix this in the new draft.\n` : "") +
    `\nFields:\n` +
    `- kicker: optional short setup shown above the quote, max 4 words, or an empty string. Use it rarely, only when the quote reads as its punchline.\n` +
    `- quote: the line on the image, 4 to 22 words, plain text.\n` +
    `- caption: one or two short lines that add to the quote (do not just repeat it), ending with a question or prompt that invites comments or tagging a partner. Max ${account.captionMaxWords} words. One or two emoji are fine. No hashtags.\n` +
    `- altText: a plain description of the image for screen readers, including the quote text.\n` +
    (photo
      ? `- photoQuery: 2 to 4 words to search a stock photo site for a warm, candid, non-sexual background photo that fits the quote (for example "couple coffee kitchen", "holding hands sunset"). No celebrities or brands.\n`
      : "") +
    `\nRespond with ONLY valid JSON in this exact shape:\n` +
    `{"kicker":"","quote":"","caption":"","altText":""${photo ? ',"photoQuery":""' : ""}}`;

  return parseJson(await callClaude(system, user));
}

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

function tidy(p) {
  const strip = (s) => String(s || "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  return { ...p, kicker: strip(p.kicker), quote: strip(p.quote), caption: String(p.caption || "").trim() };
}

function validate(p, photo) {
  if (!p || typeof p !== "object") return "Draft was not a JSON object";
  if (!isStr(p.quote)) return "quote is missing";
  if (words(p.quote) < 4 || words(p.quote) > 22) return "quote must be 4 to 22 words";
  if (p.kicker && words(p.kicker) > 4) return "kicker must be 4 words or fewer";
  if (!isStr(p.caption)) return "caption is missing";
  if (words(p.caption) > account.captionMaxWords + 8) return `caption is longer than ${account.captionMaxWords} words`;
  if (/#/.test(p.caption)) return "caption must not contain hashtags";
  if (!isStr(p.altText)) return "altText is missing";
  const onImage = `${p.kicker} ${p.quote}`;
  if (/\p{Extended_Pictographic}/u.test(onImage)) return "quote and kicker must not contain emoji";
  if (/[—–]/.test(onImage + p.caption)) return "do not use em dashes or en dashes";
  if (/[#@]/.test(onImage)) return "quote and kicker must not contain hashtags or mentions";
  if (photo && !isStr(p.photoQuery)) return "photoQuery is missing";
  return null;
}

async function reviewPost(post, pillar) {
  const system =
    `You are a strict content reviewer for an Instagram account that publishes with no human approval. ` +
    `Reject anything that could embarrass the account, get it restricted by Instagram, or hurt someone.\n\n` +
    briefText();

  const user =
    `Pillar: ${account.pillars[pillar].label}\n` +
    `Pillar guidance: ${account.pillars[pillar].guidance}\n` +
    `Review this draft post:\n${JSON.stringify(post, null, 2)}\n\n` +
    `Judge the tone against THIS pillar's guidance, not the other pillars. A sweet, spicy or motivational post does not need to be funny. ` +
    `Reject for real problems (rules, safety, explicitness, a weak or confusing line), not for small style preferences.\n\n` +
    `Approve only if ALL of these are true:\n` +
    `- It follows every rule and avoids every banned topic above.\n` +
    `- The quote is original. It is not a famous quote, lyric, movie line or well-known viral post, and it is not attributed to anyone.\n` +
    `- Humor is affectionate and does not demean either partner or rely on gender stereotypes.\n` +
    `- If it is spicy, it is suggestive only: nothing explicit, crude, or likely to be flagged as sexual content.\n` +
    `- It reads well on its own, and the joke or sentiment lands in one read.\n` +
    `- The caption adds something and ends with an invitation to engage. Asking followers to tag their own partner is fine.\n\n` +
    `Respond with ONLY valid JSON: {"approved": true or false, "reason": "one sentence"}`;

  return parseJson(await callClaude(system, user, 300));
}

// ---------- Photos (optional) ----------

async function fetchPhoto(query) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  const params = new URLSearchParams({ query, orientation: "portrait", content_filter: "high" });
  const res = await fetch(`https://api.unsplash.com/photos/random?${params}`, {
    headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
  });
  if (!res.ok) throw new Error(`Unsplash error ${res.status}: ${await res.text()}`);
  const photo = await res.json();

  const img = await fetch(photo.urls.regular);
  if (!img.ok) throw new Error(`Could not download photo: ${img.status}`);
  const buffer = Buffer.from(await img.arrayBuffer());

  // Unsplash API guidelines: register a download when a photo is used
  fetch(`${photo.links.download_location}`, { headers: { Authorization: `Client-ID ${key}` } }).catch(() => {});

  return {
    buffer,
    credit: `📷 ${photo.user.name} on Unsplash`,
    id: photo.id,
  };
}

// ---------- Image rendering ----------

const W = 1080;
const H = 1350;
const M = 96; // space-24 safe margin
const DISPLAY = "Fraunces";
const SANS = "DM Sans";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrap(text, maxChars) {
  const ws = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of ws) {
    if (!line) line = w;
    else if ((line + " " + w).length <= maxChars) line += " " + w;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Largest size whose wrapped text fits within maxLines. factor = average glyph width in em.
function fitText(text, sizes, maxWidth, maxLines, factor) {
  for (const size of sizes) {
    const maxChars = Math.floor(maxWidth / (size * factor));
    const lines = wrap(text, maxChars);
    if (lines.length <= maxLines && lines.every((l) => l.length <= maxChars)) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  return { size, lines: wrap(text, Math.floor(maxWidth / (size * factor))) };
}

// Balance line lengths so short last lines ("the fries.") don't dangle
function balance(text, size, maxWidth, factor, lineCount) {
  const total = text.length;
  for (let target = Math.ceil(total / lineCount); target * size * factor <= maxWidth; target++) {
    const lines = wrap(text, target);
    if (lines.length <= lineCount) return lines;
  }
  return null;
}

const HEART = "M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z";

function quoteBlock({ kicker, quote }, colors, centerY, maxWidth) {
  const words4 = words(quote);
  const sizes = words4 <= 8 ? [104, 96, 88, 80] : words4 <= 14 ? [86, 80, 72, 64] : [68, 62, 58, 54, 50];
  const factor = 0.46;
  const fit = fitText(quote, sizes, maxWidth, 7, factor);
  const lines = balance(quote, fit.size, maxWidth, factor, fit.lines.length) || fit.lines;
  const lh = Math.round(fit.size * (fit.size >= 76 ? 1.06 : 1.12));

  const kickerH = kicker ? 34 + 32 : 0; // kicker line + space-8
  const blockH = kickerH + (lines.length - 1) * lh + fit.size * 0.75;
  let y = Math.round(centerY - blockH / 2);

  let svg = "";
  if (kicker) {
    svg += `<text x="${W / 2}" y="${y + 24}" font-family="${SANS}" font-weight="700" font-size="28" letter-spacing="4" fill="${colors.text}" text-anchor="middle">${esc(kicker.toUpperCase())}</text>`;
    y += kickerH;
  }
  const first = y + Math.round(fit.size * 0.75);
  svg += lines
    .map(
      (l, i) =>
        `<text x="${W / 2}" y="${first + i * lh}" font-family="${DISPLAY}" font-weight="${fit.size >= 58 ? 600 : 500}" font-size="${fit.size}" fill="${colors.text}" text-anchor="middle">${esc(l)}</text>`
    )
    .join("\n  ");
  return { svg, height: blockH };
}

function footer(colors, y) {
  const handle = account.handle;
  const textW = handle.length * 26 * 0.55;
  const total = 30 + 8 + textW; // heart + space-2 + text
  const x0 = W / 2 - total / 2;
  return (
    `<g transform="translate(${x0} ${y - 25}) scale(1.25)"><path d="${HEART}" fill="${colors.heart}"/></g>` +
    `<text x="${x0 + 38}" y="${y}" font-family="${SANS}" font-weight="500" font-size="26" fill="${colors.footer}">${esc(handle)}</text>`
  );
}

function buildTextSvg(post, pillar) {
  const c = account.pillars[pillar];
  const block = quoteBlock(post, c, (H - 60) / 2, W - 2 * M - 40);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${c.background}"/>
  ${block.svg}
  ${footer(c, H - M)}
</svg>`;
}

// Follow slide: the second slide of every post, in the same color as the quote slide
// (photo posts use the cream "sweet" colors) so the carousel feels like one piece
function buildFollowSvg(pillar, photo) {
  const f = account.followSlide;
  const c = photo ? account.pillars.sweet : account.pillars[pillar];
  const maxW = W - 2 * M - 40;
  const block = quoteBlock({ kicker: f.kicker || "", quote: f.text }, c, H / 2 - 110, maxW);

  const btnW = 620;
  const btnH = 110;
  const btnX = (W - btnW) / 2;
  const btnY = Math.round(H / 2 - 110 + block.height / 2 + 90);
  const heartY = Math.round(H / 2 - 110 - block.height / 2 - 150);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${c.background}"/>
  <g transform="translate(${W / 2 - 42} ${heartY}) scale(3.5)"><path d="${HEART}" fill="${c.heart}"/></g>
  ${block.svg}
  <rect x="${btnX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="${btnH / 2}" fill="${c.text}"/>
  <text x="${W / 2}" y="${btnY + 70}" font-family="${SANS}" font-weight="700" font-size="40" fill="${c.background}" text-anchor="middle">${esc(f.button || "Follow " + account.handle)}</text>
</svg>`;
}

// ---------- Reels (animated 9:16 video) ----------
//
// Timeline (seconds, default 9s total):
//   0.0  background, heart and handle
//   0.3  kicker fades in, then each quote line fades in and rises, staggered
//   hold so the quote can be read
//   end  crossfade to the follow card (if enabled), which holds to the end
// Text stays inside Instagram's Reels safe zone (clear of the top bar and the caption/buttons).

const RW = 1080;
const RH = 1920;
const FPS = 30;

function reelLayout({ kicker, quote }, centerY, maxWidth) {
  const n = words(quote);
  const sizes = n <= 8 ? [110, 100, 92, 84] : n <= 14 ? [92, 84, 76, 68] : [74, 68, 62, 58, 54];
  const factor = 0.46;
  const fit = fitText(quote, sizes, maxWidth, 8, factor);
  const lines = balance(quote, fit.size, maxWidth, factor, fit.lines.length) || fit.lines;
  const lh = Math.round(fit.size * (fit.size >= 76 ? 1.08 : 1.14));
  const kickerH = kicker ? 36 + 40 : 0;
  const blockH = kickerH + (lines.length - 1) * lh + fit.size * 0.75;
  const top = Math.round(centerY - blockH / 2);
  return { lines, size: fit.size, lh, kickerY: top + 26, first: top + kickerH + Math.round(fit.size * 0.75), blockH, top };
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => 1 - Math.pow(1 - clamp01(x), 3); // ease-out cubic

function reelFrameSvg(post, pillar, t, L, timing) {
  const c = account.pillars[pillar];
  const f = account.followSlide || {};
  const cx = RW / 2;
  const centerY = 860;

  // Quote card opacity (fades out when the follow card comes in)
  const out = timing.followAt ? 1 - clamp01((t - timing.followAt) / 0.5) : 1;

  let quote = "";
  if (post.kicker) {
    const a = ease((t - 0.3) / 0.5) * out;
    quote += `<text x="${cx}" y="${L.kickerY}" opacity="${a.toFixed(3)}" font-family="${SANS}" font-weight="700" font-size="32" letter-spacing="5" fill="${c.text}" text-anchor="middle">${esc(post.kicker.toUpperCase())}</text>`;
  }
  L.lines.forEach((line, i) => {
    const start = timing.linesAt + i * timing.stagger;
    const p = ease((t - start) / 0.55);
    const dy = Math.round((1 - p) * 28);
    quote += `<text x="${cx}" y="${L.first + i * L.lh + dy}" opacity="${(p * out).toFixed(3)}" font-family="${DISPLAY}" font-weight="${L.size >= 62 ? 600 : 500}" font-size="${L.size}" fill="${c.text}" text-anchor="middle">${esc(line)}</text>`;
  });

  // Heart above the quote: pops in once the last line lands
  const popT = timing.linesAt + (L.lines.length - 1) * timing.stagger + 0.45;
  const pop = clamp01((t - popT) / 0.35);
  const scale = pop === 0 ? 0 : pop < 0.7 ? (pop / 0.7) * 1.2 : 1.2 - ((pop - 0.7) / 0.3) * 0.2;
  const heartSize = 72 * scale;
  const hk = heartSize / 24;
  const heartY = L.top - 90;
  const heart =
    scale > 0
      ? `<g opacity="${out.toFixed(3)}" transform="translate(${cx - 12 * hk} ${heartY - 13 * hk}) scale(${hk})"><path d="${HEART}" fill="${c.heart}"/></g>`
      : "";

  // Follow card
  let follow = "";
  if (timing.followAt) {
    const a = ease((t - timing.followAt - 0.2) / 0.6);
    if (a > 0) {
      const FL = reelLayout({ kicker: f.kicker || "", quote: f.text }, centerY - 40, RW - 2 * M - 40);
      const dy = Math.round((1 - a) * 24);
      if (f.kicker) {
        follow += `<text x="${cx}" y="${FL.kickerY + dy}" font-family="${SANS}" font-weight="700" font-size="32" letter-spacing="5" fill="${c.text}" text-anchor="middle">${esc(f.kicker.toUpperCase())}</text>`;
      }
      follow += FL.lines
        .map(
          (l, i) =>
            `<text x="${cx}" y="${FL.first + i * FL.lh + dy}" font-family="${DISPLAY}" font-weight="600" font-size="${FL.size}" fill="${c.text}" text-anchor="middle">${esc(l)}</text>`
        )
        .join("");
      const btnW = 640;
      const btnH = 116;
      const btnY = FL.top + FL.blockH + 90 + dy;
      follow +=
        `<rect x="${(RW - btnW) / 2}" y="${btnY}" width="${btnW}" height="${btnH}" rx="${btnH / 2}" fill="${c.text}"/>` +
        `<text x="${cx}" y="${btnY + 74}" font-family="${SANS}" font-weight="700" font-size="42" fill="${c.background}" text-anchor="middle">${esc(f.button || "Follow " + account.handle)}</text>`;
      follow = `<g opacity="${a.toFixed(3)}">${follow}</g>`;
    }
  }

  // Handle stays put the whole time, above the area the Reels caption covers
  const handle = `<text x="${cx}" y="1420" font-family="${SANS}" font-weight="500" font-size="30" fill="${c.footer}" text-anchor="middle">${esc(account.handle)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RW}" height="${RH}" viewBox="0 0 ${RW} ${RH}">
  <rect width="${RW}" height="${RH}" fill="${c.background}"/>
  ${heart}
  ${quote}
  ${follow}
  ${handle}
</svg>`;
}

function pickAudio() {
  const dir = path.join(__dirname, "audio");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /\.(mp3|m4a|aac|wav)$/i.test(f));
  return files.length ? path.join(dir, files[Math.floor(Math.random() * files.length)]) : null;
}

// Renders the Reel to outMp4 and a cover image (the fully revealed quote) to coverJpg
async function renderReel(post, pillar, outMp4, coverJpg) {
  const { execFileSync } = require("child_process");
  const os = require("os");
  const r = account.reels || {};
  const duration = Math.min(30, Math.max(6, Number(r.durationSeconds) || 9));
  const hasFollow = account.followSlide && account.followSlide.enabled;

  const L = reelLayout(post, 860, RW - 2 * M - 40);
  const timing = {
    linesAt: post.kicker ? 0.8 : 0.4,
    stagger: 0.45,
    followAt: hasFollow ? duration - 2.8 : null,
  };
  const revealed = timing.linesAt + (L.lines.length - 1) * timing.stagger + 1.0;
  if (hasFollow && timing.followAt < revealed + 2.5) timing.followAt = revealed + 2.5; // always leave time to read

  const total = Math.ceil(Math.max(duration, (timing.followAt || 0) + 2.8) * FPS);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reel-"));
  let lastSvg = "";
  let lastBuf = null;
  for (let i = 0; i < total; i++) {
    const svg = reelFrameSvg(post, pillar, i / FPS, L, timing);
    if (svg !== lastSvg) {
      lastBuf = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
      lastSvg = svg;
    }
    fs.writeFileSync(path.join(tmp, `${String(i).padStart(4, "0")}.jpg`), lastBuf);
  }

  // Cover: the moment the full quote and heart are showing
  const coverT = Math.min(revealed + 0.5, (timing.followAt || duration) - 0.1);
  await sharp(Buffer.from(reelFrameSvg(post, pillar, coverT, L, timing))).jpeg({ quality: 92 }).toFile(coverJpg);

  const seconds = (total / FPS).toFixed(2);
  const audio = pickAudio();
  const args = ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(tmp, "%04d.jpg")];
  if (audio) {
    args.push("-stream_loop", "-1", "-i", audio);
    args.push("-af", `afade=t=in:d=0.6,afade=t=out:st=${(total / FPS - 1.2).toFixed(2)}:d=1.2,volume=0.8`);
  } else {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }
  args.push(
    "-t", seconds,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS), "-crf", "20",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-movflags", "+faststart",
    outMp4
  );
  execFileSync("ffmpeg", args, { stdio: "inherit" });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { seconds: Number(seconds), audio: audio ? path.basename(audio) : null };
}

function chooseFormat(slot) {
  const forced = (process.env.FORMAT || "auto").trim().toLowerCase();
  if (forced === "reel" || forced === "image") return forced;
  const r = account.reels || {};
  if (!r.enabled) return "image";
  return (r.slots || []).includes(slot) ? "reel" : "image";
}

// Photo posts: the photo fills the canvas and the quote sits on a paper panel near the bottom
function buildPhotoOverlaySvg(post) {
  const colors = { text: "#3B2A20", footer: "#7A6656", heart: "#C8401F" };
  const panelX = M - 24;
  const panelW = W - 2 * panelX;
  const inner = panelW - 2 * 56;
  // Measure first, then place
  const probe = quoteBlock(post, colors, 0, inner);
  const panelH = Math.round(probe.height + 56 * 2 + 70);
  const panelY = H - M - panelH + 24;
  const block = quoteBlock(post, colors, panelY + 56 + probe.height / 2, inner);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="4" fill="#FBF6EE"/>
  ${block.svg}
  ${footer(colors, panelY + panelH - 44)}
</svg>`;
}

async function renderImage(post, pillar, photo, outPath) {
  if (photo) {
    const base = await sharp(photo.buffer).resize(W, H, { fit: "cover", position: "attention" }).toBuffer();
    await sharp(base)
      .composite([{ input: Buffer.from(buildPhotoOverlaySvg(post)) }])
      .jpeg({ quality: 92 })
      .toFile(outPath);
  } else {
    await sharp(Buffer.from(buildTextSvg(post, pillar))).jpeg({ quality: 92 }).toFile(outPath);
  }
}

function pickHashtags() {
  const pool = [...account.hashtagPool];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return [account.brandHashtag, ...pool.slice(0, account.hashtagCount - 1)];
}

// ---------- Main ----------

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

  const history = loadHistory();
  const { pillar, slot } = choosePillar(history);
  const format = chooseFormat(slot === "manual" ? slotFor(new Date()).name : slot);
  let photoMode = format === "image" && wantsPhoto(history);
  console.log(`Slot: ${slot} | Pillar: ${pillar} | Format: ${format} | Photo: ${photoMode}`);

  let approved = null;
  let feedback = "";

  for (let attempt = 1; attempt <= account.maxAttempts; attempt++) {
    console.log(`Draft attempt ${attempt}/${account.maxAttempts}...`);
    let candidate;
    try {
      candidate = tidy(await draftPost(pillar, photoMode, history, feedback));
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      feedback = `Your response could not be parsed (${err.message}). Respond with only the JSON object.`;
      console.log(`  Unparseable draft: ${err.message}`);
      continue;
    }

    const problem = validate(candidate, photoMode);
    if (problem) {
      feedback = problem;
      console.log(`  Failed local checks: ${problem}`);
      continue;
    }

    let review;
    try {
      review = await reviewPost(candidate, pillar);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      feedback = "The reviewer could not evaluate the draft. Keep it simple and within the rules.";
      console.log(`  Unparseable review: ${err.message}`);
      continue;
    }
    if (review.approved === true) {
      approved = candidate;
      console.log(`  Approved: "${candidate.quote}"`);
      break;
    }
    feedback = review.reason || "Reviewer rejected the draft.";
    console.log(`  Rejected by reviewer: ${feedback}`);
  }

  if (!approved) throw new Error(`No acceptable draft after ${account.maxAttempts} attempts. Last problem: ${feedback}`);

  let photo = null;
  if (photoMode) {
    try {
      photo = await fetchPhoto(approved.photoQuery);
      console.log(`Photo: ${photo.id} (${approved.photoQuery})`);
    } catch (err) {
      console.log(`Photo failed, falling back to a text post: ${err.message}`);
    }
  }

  const caption = [approved.caption, photo ? photo.credit : null, pickHashtags().join(" ")].filter(Boolean).join("\n\n");

  const dir = DRY_RUN ? "drafts" : "images";
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

  if (format === "reel") {
    // The video is uploaded straight to Instagram and is not committed (keeps the repo small).
    // The cover image is committed so Instagram can fetch it by URL.
    fs.mkdirSync(path.join(__dirname, "reels"), { recursive: true });
    const videoFile = `reels/reel-${stamp}.mp4`;
    const coverFile = `${dir}/reel-${stamp}-cover.jpg`;
    console.log("Rendering Reel...");
    const info = await renderReel(approved, pillar, path.join(__dirname, videoFile), path.join(__dirname, coverFile));
    console.log(`Reel: ${info.seconds}s, audio: ${info.audio || "silent"}`);

    const post = {
      format: "reel",
      pillar,
      slot,
      kicker: approved.kicker,
      quote: approved.quote,
      headline: approved.quote,
      caption,
      videoFile,
      coverFile,
      imageFiles: [coverFile],
      altTexts: [approved.altText],
      audio: info.audio,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(__dirname, "post.json"), JSON.stringify(post, null, 2));
    console.log(`Wrote post.json, ${videoFile} and ${coverFile}`);
    return;
  }

  const file = `${dir}/post-${stamp}-s01.jpg`;
  await renderImage(approved, pillar, photo, path.join(__dirname, file));
  const imageFiles = [file];
  const altTexts = [approved.altText];

  if (account.followSlide && account.followSlide.enabled) {
    const followFile = `${dir}/post-${stamp}-s02.jpg`;
    await sharp(Buffer.from(buildFollowSvg(pillar, photo))).jpeg({ quality: 92 }).toFile(path.join(__dirname, followFile));
    imageFiles.push(followFile);
    altTexts.push(account.followSlide.altText || account.followSlide.text);
  }

  const post = {
    format: "image",
    pillar,
    slot,
    kicker: approved.kicker,
    quote: approved.quote,
    headline: approved.quote,
    caption,
    imageFiles,
    altTexts,
    photo: photo ? { id: photo.id, query: approved.photoQuery } : null,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(__dirname, "post.json"), JSON.stringify(post, null, 2));
  console.log(`Wrote post.json and ${imageFiles.join(", ")}`);
}

module.exports = { buildTextSvg, buildFollowSvg, renderReel, reelFrameSvg, chooseFormat, buildPhotoOverlaySvg, renderImage, validate, choosePillar, main };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
