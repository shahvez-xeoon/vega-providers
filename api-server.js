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
const LOCAL_URLS_JSON = path.join(__dirname, 'urls.json');

if (typeof global.fetch !== 'function') {
  global.fetch = async (url, opts = {}) => {
    const res = await axios({
      url: String(url),
      method: opts.method || 'GET',
      headers: opts.headers || {},
      data: opts.body,
      timeout: 12000,
      validateStatus: () => true,
    });
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.statusText || '',
      text: async () =>
        typeof res.data === 'string' ? res.data : JSON.stringify(res.data),
      json: async () =>
        typeof res.data === 'string' ? JSON.parse(res.data) : res.data,
    };
  };
}

let cachedUrlsMap = null;
function loadLocalUrls() {
  if (cachedUrlsMap) return cachedUrlsMap;
  try {
    if (fs.existsSync(LOCAL_URLS_JSON)) {
      cachedUrlsMap = JSON.parse(fs.readFileSync(LOCAL_URLS_JSON, 'utf8'));
      return cachedUrlsMap;
    }
  } catch (_) {}
  cachedUrlsMap = {};
  return cachedUrlsMap;
}

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
    urls: loadLocalUrls(),
    signal: new AbortController().signal,
  };
}

function loadProviders(mediaType) {
  if (!fs.existsSync(VEGA_DIST)) return [];
  const dirs = fs
    .readdirSync(VEGA_DIST, { withFileTypes: true })
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
      try {
        return {
          name,
          postsMod: require(postsPath),
          streamMod: require(streamPath),
          metaMod: fs.existsSync(metaPath) ? require(metaPath) : null,
        };
      } catch (e) {
        return { name, loadError: e.message };
      }
    })
    .filter(Boolean);
}

app.get('/health', (req, res) => {
  const count = fs.existsSync(VEGA_DIST)
    ? fs
        .readdirSync(VEGA_DIST, { withFileTypes: true })
        .filter((d) => d.isDirectory()).length
    : 0;
  res.json({ ok: true, providersAvailable: count });
});

app.get('/resolve', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const type = String(req.query.type || 'movie').trim().toLowerCase();
  const season = Number(req.query.season || 1) || 1;
  const episode = Number(req.query.episode || 1) || 1;
  const debug = String(req.query.debug || '') === '1';

  if (!title) {
    return res.status(400).json({ error: 'title query parameter is required' });
  }

  const ctx = makeProviderContext();
  const providers = loadProviders(type).slice(0, 14);
  const collected = [];
  const trace = [];

  for (const prov of providers) {
    if (prov.loadError) {
      trace.push({ provider: prov.name, step: 'load', error: prov.loadError });
      continue;
    }
    try {
      if (typeof prov.postsMod?.getSearchPosts !== 'function') {
        trace.push({ provider: prov.name, step: 'search', error: 'no getSearchPosts' });
        continue;
      }

      const posts = await Promise.race([
        prov.postsMod.getSearchPosts({
          searchQuery: title,
          page: 1,
          signal: ctx.signal,
          providerContext: ctx,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('search timeout')), 10000)
        ),
      ]);

      const postCount = Array.isArray(posts) ? posts.length : 0;
      if (postCount === 0) {
        trace.push({ provider: prov.name, step: 'search', posts: 0 });
        continue;
      }

      const topPost = posts[0];
      let targetUrl = topPost.link;
      let streamType = type === 'anime' ? 'anime' : 'movie';

      if (
        (type === 'tv' || type === 'anime') &&
        prov.metaMod &&
        typeof prov.metaMod.getMeta === 'function'
      ) {
        try {
          const meta = await Promise.race([
            prov.metaMod.getMeta({
              link: topPost.link,
              signal: ctx.signal,
              providerContext: ctx,
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('meta timeout')), 9000)
            ),
          ]);
          const links = meta?.linkList || meta?.episodes || [];
          if (Array.isArray(links) && links.length > 0) {
            const matched =
              links.find(
                (ep) =>
                  Number(ep.season || 1) === season &&
                  Number(ep.episode || ep.number || 0) === episode
              ) ||
              links[episode - 1] ||
              links[0];
            if (matched && matched.link) {
              targetUrl = matched.link;
              streamType = 'series';
            }
          }
        } catch (e) {
          trace.push({ provider: prov.name, step: 'meta', error: e.message });
        }
      }

      let foundInProv = 0;
      if (typeof prov.streamMod?.getStream === 'function' && targetUrl) {
        const rawStreams = await Promise.race([
          prov.streamMod.getStream({
            url: targetUrl,
            type: streamType,
            signal: ctx.signal,
            providerContext: ctx,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('stream timeout')), 14000)
          ),
        ]);

        if (Array.isArray(rawStreams)) {
          for (const s of rawStreams) {
            if (s && s.link) {
              foundInProv++;
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

      trace.push({
        provider: prov.name,
        posts: postCount,
        streams: foundInProv,
      });

      if (collected.length >= 6) break;
    } catch (e) {
      trace.push({ provider: prov.name, error: e.message });
    }
  }

  const payload = {
    title,
    type,
    season,
    episode,
    streamsFound: collected.length,
    streams: collected,
  };
  if (debug) payload.trace = trace;
  return res.json(payload);
});

app.listen(PORT, () => {
  console.log(`Nexsa Vega API running on port ${PORT}`);
});
