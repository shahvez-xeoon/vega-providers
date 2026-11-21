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

const wait = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

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

async function getTargetLinks(dir, postLink, type, season, episode, ctx) {
  const metaPath = path.join(dir, 'meta.js');
  const epPath = path.join(dir, 'episodes.js');
  if (!fs.existsSync(metaPath)) return [postLink];
  const metaMod = require(metaPath);
  if (typeof metaMod.getMeta !== 'function') return [postLink];

  const meta = await wait(metaMod.getMeta({ link: postLink, providerContext: ctx }), 10000);
  const list = Array.isArray(meta && meta.linkList) ? meta.linkList : [];
  if (!list.length) return [postLink];

  const links = [];
  if (type !== 'movie') {
    const sMatch = list.find((x) => new RegExp('S0?' + season + '\\b|Season\\s*0?' + season, 'i').test(x.title || '')) || list[0];
    if (sMatch && sMatch.episodesLink && fs.existsSync(epPath)) {
      const epMod = require(epPath);
      if (typeof epMod.getEpisodes === 'function') {
        const eps = await wait(epMod.getEpisodes({ url: sMatch.episodesLink, providerContext: ctx }), 10000);
        if (Array.isArray(eps) && eps.length) {
          const picked = eps[episode - 1] || eps[0];
          if (picked && picked.link) links.push(picked.link);
        }
      }
    }
    if (!links.length && sMatch && Array.isArray(sMatch.directLinks)) {
      const picked = sMatch.directLinks[episode - 1] || sMatch.directLinks[0];
      if (picked && picked.link) links.push(picked.link);
    }
  } else {
    for (const item of list) {
      if (Array.isArray(item.directLinks)) {
        for (const d of item.directLinks) {
          if (d && d.link && links.length < 3) links.push(d.link);
        }
      }
      if (item.episodesLink && links.length < 3) links.push(item.episodesLink);
      if (links.length >= 3) break;
    }
  }
  return links.length ? links : [postLink];
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
  const order = type === 'anime'
    ? ['animesalt', 'animeworld', 'hiAnime', 'animesub']
    : ['hdhub4u', '4khdhub', 'castle', 'moviesmod', 'vega', 'mod'];

  for (const name of order) {
    const dir = path.join(VEGA_DIST, name);
    if (!fs.existsSync(path.join(dir, 'posts.js')) || !fs.existsSync(path.join(dir, 'stream.js'))) continue;
    try {
      const postsMod = require(path.join(dir, 'posts.js'));
      const streamMod = require(path.join(dir, 'stream.js'));
      const posts = await wait(
        postsMod.getSearchPosts({ searchQuery: title, page: 1, signal: ctx.signal, providerContext: ctx }),
        9000
      );
      if (!Array.isArray(posts) || !posts.length) {
        trace.push({ provider: name, posts: 0 });
        continue;
      }
      const targetLinks = await getTargetLinks(dir, posts[0].link, type, season, episode, ctx);
      let found = 0;
      for (const tLink of targetLinks) {
        try {
          const raw = await wait(
            streamMod.getStream({
              link: tLink,
              url: tLink,
              type: type === 'movie' ? 'movie' : 'series',
              providerContext: ctx,
              signal: ctx.signal,
            }),
            12000
          );
          const items = normalizeStreams(raw, name);
          collected.push(...items);
          found += items.length;
          if (collected.length >= 4) break;
        } catch (se) {
          trace.push({ provider: name, link: tLink.slice(0, 60), streamErr: se.message });
        }
      }
      trace.push({ provider: name, posts: posts.length, metaLinks: targetLinks.length, streams: found });
      if (collected.length >= 4) break;
    } catch (e) {
      trace.push({ provider: name, error: e.message });
    }
  }

  const out = { title, tmdbId, type, season, episode, streamsFound: collected.length, streams: collected };
  if (debug) out.trace = trace;
  res.json(out);
});

app.listen(PORT, () => console.log('Nexsa Vega API live on ' + PORT));
