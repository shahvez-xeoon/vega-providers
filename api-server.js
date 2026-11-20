const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VEGA_DIST = path.join(__dirname, 'dist');

const commonHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
};

function makeProviderContext() {
  return {
    axios,
    cheerio,
    commonHeaders,
    headers: commonHeaders,
    signal: new AbortController().signal,
  };
}

function loadProviders(mediaType) {
  if (!fs.existsSync(VEGA_DIST)) return [];
  const dirs = fs.readdirSync(VEGA_DIST, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const animeOrder = [
    'animesalt',
    'animesub',
    'animeworld',
    'animetsu',
    'anikoto',
    'aniDream',
    'hiAnime',
    'kickAssAnime',
    'kissKh',
    'kartoons',
  ];
  const movieTvOrder = [
    '4khdhub',
    'cinemaLuxe',
    '1cinevood',
    '1flex',
    'hdhub4u',
    'extraflix',
    'disneyMirror',
    'castle',
    'autoEmbed',
    'gokuHD',
    'flixhq',
  ];

  const preferred = mediaType === 'anime' ? animeOrder : movieTvOrder;
  const rank = (name) => {
    const idx = preferred.indexOf(name);
    return idx === -1 ? 999 : idx;
  };

  return dirs
    .sort((a, b) => rank(a) - rank(b))
    .map((name) => {
      const dir = path.join(VEGA_DIST, name);
      const postsPath = path.join(dir, 'posts.js');
      const streamPath = path.join(dir, 'stream.js');
      const metaPath = path.join(dir, 'meta.js');
      if (!fs.existsSync(postsPath) || !fs.existsSync(streamPath)) return null;
      return {
        name,
        postsMod: require(postsPath),
        streamMod: require(streamPath),
        metaMod: fs.existsSync(metaPath) ? require(metaPath) : null,
      };
    })
    .filter(Boolean);
}

app.get('/health', (req, res) => {
  const count = fs.existsSync(VEGA_DIST)
    ? fs.readdirSync(VEGA_DIST, { withFileTypes: true }).filter((d) => d.isDirectory()).length
    : 0;
  res.json({ ok: true, providersAvailable: count });
});

app.get('/resolve', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const type = String(req.query.type || 'movie').trim().toLowerCase();
  const season = Number(req.query.season || 1) || 1;
  const episode = Number(req.query.episode || 1) || 1;

  if (!title) {
    return res.status(400).json({ error: 'title query parameter is required' });
  }

  const ctx = makeProviderContext();
  const providers = loadProviders(type).slice(0, 8);
  const collected = [];

  for (const prov of providers) {
    try {
      if (typeof prov.postsMod.getSearchPosts !== 'function') continue;
      const posts = await Promise.race([
        prov.postsMod.getSearchPosts({
          searchQuery: title,
          page: 1,
          signal: ctx.signal,
          providerContext: ctx,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('search timeout')), 9000)
        ),
      ]);

      if (!Array.isArray(posts) || posts.length === 0) continue;
      const topPost = posts[0];
      let targetUrl = topPost.link;
      let streamType = type === 'anime' ? 'anime' : 'movie';

      if ((type === 'tv' || type === 'anime') && prov.metaMod && typeof prov.metaMod.getMeta === 'function') {
        try {
          const meta = await Promise.race([
            prov.metaMod.getMeta({ link: topPost.link, providerContext: ctx }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('meta timeout')), 8000)
            ),
          ]);
          const links = meta?.linkList || meta?.episodes || [];
          if (Array.isArray(links) && links.length > 0) {
            const matched =
              links.find(
                (ep) =>
                  Number(ep.season || 1) === season &&
                  Number(ep.episode || ep.number || 0) === episode
              ) || links[episode - 1] || links[0];
            if (matched && matched.link) {
              targetUrl = matched.link;
              streamType = 'series';
            }
          }
        } catch (_) {}
      }

      if (typeof prov.streamMod.getStream === 'function' && targetUrl) {
        const rawStreams = await Promise.race([
          prov.streamMod.getStream({
            url: targetUrl,
            type: streamType,
            signal: ctx.signal,
            providerContext: ctx,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('stream timeout')), 12000)
          ),
        ]);

        if (Array.isArray(rawStreams)) {
          for (const s of rawStreams) {
            if (s && s.link) {
              collected.push({
                provider: prov.name,
                server: s.server || prov.name,
                quality: s.quality || 'Auto',
                link: s.link,
                type: s.type || (s.link.includes('.m3u8') ? 'hls' : 'mp4'),
                headers: s.headers || commonHeaders,
                subtitles: Array.isArray(s.subtitles) ? s.subtitles : [],
              });
            }
          }
        }
      }

      if (collected.length >= 6) break;
    } catch (_) {}
  }

  return res.json({
    title,
    type,
    season,
    episode,
    streamsFound: collected.length,
    streams: collected,
  });
});

app.listen(PORT, () => {
  console.log(`Nexsa Vega API running on port ${PORT}`);
});
