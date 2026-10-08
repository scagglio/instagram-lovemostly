# Love, Mostly — headless Instagram agent

Runs **@love.mostly** on its own. Three times a day GitHub Actions wakes up and:

1. Picks a pillar for the time of day (sweet, funny, spicy or motivational), weighted to roughly 40 / 40 / 10 / 10 and never the same color twice in a row
2. Has Claude write one original quote plus a caption, then has a second Claude call review it against the rules
3. Renders a 1080×1350 image in the brand style (Fraunces on flat retro colors), or, about one post in seven, a photo post when an Unsplash key is set
4. Publishes it through the Instagram Graph API and logs it so quotes never repeat

**Cost:** about $1 to $2 a month in Claude usage with Haiku at 3 posts a day. GitHub Actions (public repo), the Meta API and Unsplash are free.

Brand rules (colors, voice, pillars) live in the Love, Mostly brand kit. `account.json` is the copy the agent reads.

## Schedule

| Slot | UTC cron | Central (daylight time) | Pillar odds |
|---|---|---|---|
| Morning | `52 12 * * *` | ~7:52am | sweet 60, motivational 30, funny 10 |
| Midday | `22 17 * * *` | ~12:22pm | funny 90, sweet 10 |
| Evening | `52 0 * * *` | ~7:52pm | sweet 50, spicy 30, funny 20 |

GitHub cron is UTC only, so after daylight saving ends on Nov 1 the posts land an hour earlier in local time. Change the `cron` lines in `.github/workflows/post.yml` if that matters. GitHub can also start runs a few minutes late.

---

## Setup

This is the same setup as the 3dCharged agent. Parts you have already done once (the Meta developer app, the Anthropic key) can be reused.

### 1. Instagram and Facebook (by hand, once)

1. In the Instagram app on @love.mostly: **Settings > Account type and tools > Switch to professional account** (Creator or Business).
2. Create a **Facebook Page** named Love, Mostly and link it to the Instagram account (Instagram > Edit profile > Page).
3. Fill out the profile: the bio from the brand kit, a profile picture (tomato circle with a cream heart works until there is a logo), and ideally 3 to 6 posts you approve from dry runs before turning on auto posting. New, empty accounts that suddenly post automatically look suspicious.

### 2. Instagram token

Reuse your existing Meta developer app from 3dCharged.

1. **developers.facebook.com > Tools > Graph API Explorer**, select your app.
2. **Generate Access Token** with `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`. When prompted, make sure the **Love, Mostly Page and @love.mostly** are ticked (you can leave 3dCharged ticked too).
3. Exchange it for a long-lived user token:
   `https://graph.facebook.com/v26.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_TOKEN`
4. Get the Page token: `https://graph.facebook.com/v26.0/me/accounts?access_token=LONG_LIVED_USER_TOKEN`. Copy the Love, Mostly Page's `id` and `access_token`.
5. Confirm it says **Expires: Never** at developers.facebook.com/tools/debug/accesstoken.
6. Get the Instagram Business ID: `https://graph.facebook.com/v26.0/PAGE_ID?fields=instagram_business_account&access_token=PAGE_TOKEN`

Regenerating a token for the new Page does not break the 3dCharged token, which is tied to its own Page.

### 3. Optional: Unsplash for photo posts

1. Sign up at **unsplash.com/developers**, create an app, and copy its **Access Key**.
2. The free demo tier allows 50 requests an hour, far more than this needs. Photo posts credit the photographer in the caption, as Unsplash requires.

Skip this and every post is text-only.

### 4. GitHub repo (`scagglio/instagram-lovemostly`)

1. Make the repo **Public** (Instagram downloads the image from GitHub).
2. Upload every file in this folder, keeping the folders: `fonts/` (4 `.ttf` files and 2 license files) and `.github/workflows/post.yml`.
3. **Settings > Secrets and variables > Actions > New repository secret**:
   - `ANTHROPIC_API_KEY` (you can reuse the 3dCharged one)
   - `IG_ACCESS_TOKEN` (the Love, Mostly Page token)
   - `IG_BUSINESS_ID` (the Love, Mostly Instagram Business ID)
   - `UNSPLASH_ACCESS_KEY` (optional)
4. **Settings > Actions > General > Workflow permissions:** Read and write. Save.

### 5. Dry runs

**Actions > Post to Instagram > Run workflow.** Leave **Draft only** checked. Use the **Pillar** dropdown to try each pillar, and tick **photo post** to test photos. The run Summary shows the image and caption. Nothing is posted. Run it 5 to 10 times and tune `account.json` until you like what comes out.

### 6. Go live

1. Run once with **Draft only** unchecked and confirm it appears on Instagram.
2. **Settings > Secrets and variables > Actions > Variables > New repository variable:** `AUTO_POST` = `true`. Scheduled runs now post for real.
3. To pause, delete `AUTO_POST` or disable the workflow.

**Ramp-up:** for the first week or two consider posting only once or twice a day. Comment out one or two `cron` lines and add them back later.

---

## Tuning

- **Pillar odds per time slot:** `slots` in `account.json`.
- **Tone and examples per pillar:** `pillars.<name>.guidance`. Changing a pillar's colors here changes the image.
- **Guardrails:** `rules` and `bannedTopics`. The reviewer enforces them.
- **Hashtags:** `hashtagPool`, `brandHashtag`, `hashtagCount`.
- **Photo frequency:** `photo.everyNthPost`.
- **Better writing:** set `model` to a Sonnet model. It costs a little more per post.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Image URL never became reachable" | Repo is not public, or the push step failed |
| Error 190 | Token invalid or expired. Redo step 2 |
| Permission errors (#10, #200) | The Love, Mostly Page or Instagram account was not ticked when generating the token |
| Boxes or a plain font on the image | `fonts/` folder missing or not uploaded |
| "No acceptable draft after 3 attempts" | Rules too strict for a pillar. Loosen them or raise `maxAttempts` |
| Push rejected | Workflow permissions not set to Read and write |

## Files

| File | Purpose |
|---|---|
| `account.json` | Brand brief, pillars, colors, slots, rules, hashtags |
| `generate.js` | Picks the pillar, drafts, reviews and renders the image |
| `publish.js` | Posts to Instagram (or writes a dry-run preview) |
| `history.json` | Log of published posts, used to avoid repeats and same-color neighbors |
| `fonts/` | Fraunces and DM Sans (SIL Open Font License) |
| `.github/workflows/post.yml` | Schedule and pipeline |
| `drafts/`, `images/` | Created automatically |
