const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;
const VEGA_DIST = path.join(__dirname, 'dist');

const commonHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
};

function makeCtx() {
  return {
    axios,
    cheerio,
    commonHeaders,
    headers: commonHeaders,
    kvStore: { get: async () => null, set: async () => {} },
    getCookies: async () => ({}),
    openWebView: async () => ({ html: '', cookies: {} }),
    signal: new AbortController().signal,
  };
}

function normalizeStreams(raw, provName) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => s && s.link && String(s.link).startsWith('http'))
    .map((s) => ({
      provider: provName,
      server: s.server || provName,
      quality: s.quality || 'Auto',
      link: s.link,
      type: s.type || (String(s.link).includes('.m3u8') ? 'hls' : 'mp4'),
      headers: s.headers || commonHeaders,
      subtitles: Array.isArray(s.subtitles)
        ? s.subtitles.map((sub) => ({
            lang: sub.title || sub.lang || sub.language || 'Sub',
            url: sub.uri || sub.url || sub.file || '',
          })).filter((sub) => sub.url.startsWith('http'))
        : [],
    }));
}

app.get('/health', (req, res) => {
  const count = fs.existsSync(VEGA_DIST)
    ? fs.readdirSync(VEGA_DIST, { withFileTypes: true }).filter((d) => d.isDirectory()).length
    : 0;
  res.json({ ok: true, providersAvailable: count });
});

app.get('/resolve', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const tmdbId = String(req.query.tmdbId || '').trim();
  const type = String(req.query.type || 'movie').trim().toLowerCase();
  const season = Number(req.query.season || 1) || 1;
  const episode = Number(req.query.episode || 1) || 1;
  const debug = String(req.query.debug || '') === '1';

  const ctx = makeCtx();
  const collected = [];
  const trace = [];

  // 1. Direct fast path: autoEmbed (uses tmdbId directly -> Cinejoy + Movy + Vidstuck)
  if (tmdbId) {
    try {
      const ae = require(path.join(VEGA_DIST, 'autoEmbed', 'stream.js'));
      const payload = JSON.stringify({
        tmdbId,
        title,
        type: type === 'movie' ? 'movie' : 'tv',
        season,
        episode,
      });
      const raw = await Promise.race([
        ae.getStream({
          link: payload,
          type: type === 'movie' ? 'movie' : 'series',
          providerContext: ctx,
          signal: ctx.signal,
          isDownload: false,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ]);
      const items = normalizeStreams(raw, 'autoEmbed');
      collected.push(...items);
      trace.push({ provider: 'autoEmbed', streams: items.length });
    } catch (e) {
      trace.push({ provider: 'autoEmbed', error: e.message });
    }
  }

  // 2. Fallback: search-based Vega providers (for Hindi / Anime / extra servers)
  if (collected.length < 3 && title) {
    const order = type === 'anime'
      ? ['animesalt', 'animeworld', 'hiAnime', 'animesub']
      : ['castle', '4khdhub', 'cinemaLuxe', 'hdhub4u'];

    for (const name of order) {
      const dir = path.join(VEGA_DIST, name);
      if (!fs.existsSync(path.join(dir, 'posts.js')) || !fs.existsSync(path.join(dir, 'stream.js'))) continue;
      try {
        const postsMod = require(path.join(dir, 'posts.js'));
        const streamMod = require(path.join(dir, 'stream.js'));
        const posts = await Promise.race([
          postsMod.getSearchPosts({ searchQuery: title, page: 1, signal: ctx.signal, providerContext: ctx }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('search timeout')), 8000)),
        ]);
        if (!Array.isArray(posts) || !posts.length) {
          trace.push({ provider: name, posts: 0 });
          continue;
        }
        const raw = await Promise.race([
          streamMod.getStream({
            link: posts[0].link,
            url: posts[0].link,
            type: type === 'movie' ? 'movie' : 'series',
            providerContext: ctx,
            signal: ctx.signal,
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('stream timeout')), 10000)),
        ]);
        const items = normalizeStreams(raw, name);
        collected.push(...items);
        trace.push({ provider: name, posts: posts.length, streams: items.length });
        if (collected.length >= 6) break;
      } catch (e) {
        trace.push({ provider: name, error: e.message });
      }
    }
  }

  const out = { title, tmdbId, type, season, episode, streamsFound: collected.length, streams: collected };
  if (debug) out.trace = trace;
  res.json(out);
});

app.listen(PORT, () => console.log('Nexsa Vega API live on ' + PORT));
