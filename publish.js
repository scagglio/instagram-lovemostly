// publish.js  (Love, Mostly)
//
// Reads post.json (written by generate.js) and publishes it to Instagram via the
// Meta Graph API. Multiple images are published as a swipeable carousel; a single
// image is published as a normal photo post. In DRY_RUN mode it only writes a preview
// to the GitHub Actions job summary and does not post anything.
//
// Environment:
//   IG_ACCESS_TOKEN, IG_BUSINESS_ID   (required unless DRY_RUN)
//   DRY_RUN                           "true" = preview only
//   GRAPH_API_VERSION                 optional override (default v26.0)
//   GITHUB_REPOSITORY, GITHUB_REF_NAME are provided automatically by GitHub Actions

const fs = require("fs");
const path = require("path");

const VERSION = process.env.GRAPH_API_VERSION || "v26.0";
const BASE = `https://graph.facebook.com/${VERSION}`;
const DRY_RUN = process.env.DRY_RUN === "true";
const HISTORY_PATH = path.join(__dirname, "history.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graph(method, endpoint, params = {}) {
  const token = process.env.IG_ACCESS_TOKEN;
  const all = { ...params, access_token: token };
  let res;
  if (method === "GET") {
    res = await fetch(`${BASE}/${endpoint}?${new URLSearchParams(all)}`);
  } else {
    // Sent as a form body so the token never appears in a URL
    res = await fetch(`${BASE}/${endpoint}`, { method, body: new URLSearchParams(all) });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = data.error || {};
    if (err.code === 190) {
      throw new Error(
        "Instagram access token is invalid or expired (error 190). Generate a new token and update the IG_ACCESS_TOKEN secret.\n" +
          JSON.stringify(err)
      );
    }
    throw new Error(`Graph API error on ${method} ${endpoint}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForImage(url) {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(url);
      if (res.ok && (res.headers.get("content-type") || "").startsWith("image/")) return;
    } catch {
      // retry
    }
    await sleep(5000);
  }
  throw new Error(`Image URL never became reachable: ${url}. Is the repository public?`);
}

async function waitFinished(containerId, label, tries = 24) {
  let status = "IN_PROGRESS";
  for (let i = 0; i < tries; i++) {
    const s = await graph("GET", containerId, { fields: "status_code" });
    status = s.status_code;
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`${label} failed with status ${status}`);
    }
    await sleep(5000);
  }
  throw new Error(`${label} was not ready in time (last status ${status})`);
}

// Create one child image for a carousel. Tries with alt text first and falls back
// to no alt text if the API rejects it.
async function createCarouselItem(igId, imageUrl, altText) {
  const base = { image_url: imageUrl, is_carousel_item: "true" };
  try {
    return await graph("POST", `${igId}/media`, { ...base, alt_text: altText.slice(0, 900) });
  } catch (err) {
    console.log(`  Retrying without alt text: ${err.message.slice(0, 200)}`);
    return await graph("POST", `${igId}/media`, base);
  }
}

// Reels: create a resumable-upload container, send the MP4 bytes straight to Instagram's
// upload host (so the video never has to be hosted on GitHub), then wait for processing.
async function createReel(igId, post, coverUrl) {
  const video = fs.readFileSync(path.join(__dirname, post.videoFile));
  const params = {
    media_type: "REELS",
    upload_type: "resumable",
    caption: post.caption,
    share_to_feed: "true",
  };
  if (coverUrl) params.cover_url = coverUrl;

  console.log("Creating Reel container...");
  const container = await graph("POST", `${igId}/media`, params);
  const uploadUri = container.uri || `https://rupload.facebook.com/ig-api-upload/${VERSION}/${container.id}`;

  console.log(`Uploading video (${(video.length / 1e6).toFixed(1)} MB)...`);
  const res = await fetch(uploadUri, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${process.env.IG_ACCESS_TOKEN}`,
      offset: "0",
      file_size: String(video.length),
    },
    body: video,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false || body.error) {
    throw new Error(`Reel upload failed (${res.status}): ${JSON.stringify(body)}`);
  }

  console.log("Waiting for Instagram to process the Reel...");
  await waitFinished(container.id, "Reel container", 72); // up to 6 minutes
  return container.id;
}

async function main() {
  const post = JSON.parse(fs.readFileSync(path.join(__dirname, "post.json"), "utf8"));
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME;
  if (!repo || !branch) {
    throw new Error("GITHUB_REPOSITORY / GITHUB_REF_NAME not set. This script is meant to run inside GitHub Actions.");
  }

  const files = post.imageFiles || [post.imageFile];
  const altTexts = post.altTexts || [post.altText || ""];
  const urls = files.map((f) => `https://raw.githubusercontent.com/${repo}/${branch}/${f}`);

  console.log(`Waiting for ${urls.length} image(s) to be reachable...`);
  for (const u of urls) await waitForImage(u);

  if (DRY_RUN && post.format === "reel") {
    const md =
      `## Reel draft preview (NOT posted)\n\n` +
      `<img src="${urls[0]}" width="240" alt="reel cover">\n\n` +
      `The cover is shown above. Download the video from the **love-mostly-reel** artifact at the bottom of this run's Summary page.\n\n` +
      `**Pillar:** ${post.pillar} (${post.slot})\n\n` +
      `**Quote:** ${post.kicker ? post.kicker + " / " : ""}${post.quote}\n\n` +
      `**Audio:** ${post.audio || "silent"}\n\n` +
      `**Caption:**\n\n\`\`\`text\n${post.caption}\n\`\`\`\n`;
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    return;
  }

  if (DRY_RUN) {
    const sheet = urls.map((u, i) => `<img src="${u}" width="320" alt="post preview">`).join(" ");
    const md =
      `## Draft preview (NOT posted)\n\n` +
      `${sheet}\n\n` +
      `**Pillar:** ${post.pillar} (${post.slot})\n\n` +
      `**Quote:** ${post.kicker ? post.kicker + " / " : ""}${post.quote}\n\n` +
      `**Caption:**\n\n\`\`\`text\n${post.caption}\n\`\`\`\n`;
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    return;
  }

  const igId = process.env.IG_BUSINESS_ID;
  if (!igId || !process.env.IG_ACCESS_TOKEN) {
    throw new Error("IG_BUSINESS_ID or IG_ACCESS_TOKEN is not set");
  }

  let creationId;
  if (post.format === "reel") {
    creationId = await createReel(igId, post, urls[0]);
  } else if (urls.length === 1) {
    console.log("Creating single-image container...");
    const container = await graph("POST", `${igId}/media`, {
      image_url: urls[0],
      caption: post.caption,
      alt_text: (altTexts[0] || "").slice(0, 900),
    });
    await waitFinished(container.id, "Image container");
    creationId = container.id;
  } else {
    console.log(`Creating ${urls.length} carousel items...`);
    const childIds = [];
    for (const [i, u] of urls.entries()) {
      const child = await createCarouselItem(igId, u, altTexts[i] || "");
      childIds.push(child.id);
      console.log(`  Item ${i + 1}/${urls.length}: ${child.id}`);
    }
    for (const [i, id] of childIds.entries()) await waitFinished(id, `Carousel item ${i + 1}`);

    console.log("Creating carousel container...");
    const carousel = await graph("POST", `${igId}/media`, {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      caption: post.caption,
    });
    await waitFinished(carousel.id, "Carousel container");
    creationId = carousel.id;
  }

  console.log("Publishing...");
  const published = await graph("POST", `${igId}/media_publish`, { creation_id: creationId });

  let permalink = "";
  try {
    permalink = (await graph("GET", published.id, { fields: "permalink" })).permalink || "";
  } catch {
    // permalink is nice-to-have
  }
  console.log(`Published! Media ID: ${published.id} ${permalink}`);

  const history = fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) : [];
  history.push({
    date: new Date().toISOString(),
    format: post.format || "image",
    pillar: post.pillar,
    slot: post.slot,
    kicker: post.kicker,
    quote: post.quote,
    photo: post.photo,
    caption: post.caption,
    imageFiles: files,
    mediaId: published.id,
    permalink,
  });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
