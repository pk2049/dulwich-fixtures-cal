const https = require('https');
const http = require('http');

// Dribl-powered NSW Comps page — same data, more scraping-friendly
const FIXTURES_URL = 'https://nswcomps.dribl.com/fixtures/?date_range=default&season=wOmelzGd02&competition=3vmZvv5Rmq&club=kemAonRKB7&league=LBdDVMz4Nb&timezone=Australia%2FSydney';

const CALENDAR_NAME = 'Dulwich Hill FC U12 Mixed 2026';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cache = { ics: null, fetchedAt: null };

function fetchPage(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      const chunks = [];
      let stream = res;

      // Handle compressed responses
      if (res.headers['content-encoding'] === 'gzip') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createGunzip());
      } else if (res.headers['content-encoding'] === 'deflate') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createInflate());
      } else if (res.headers['content-encoding'] === 'br') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createBrotliDecompress());
      }

      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseFixtures(html) {
  // Dribl pages are React SPAs — look for embedded JSON state
  const patterns = [
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?});\s*<\/script>/,
    /window\.__data\s*=\s*({[\s\S]+?});\s*<\/script>/,
    /window\.initialData\s*=\s*({[\s\S]+?});\s*<\/script>/,
    /__NEXT_DATA__[^>]*>({[\s\S]+?})<\/script>/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        const candidates = [
          data.fixtures, data.matches, data.games,
          data?.competition?.fixtures, data?.league?.fixtures,
          data?.data?.fixtures, data?.props?.pageProps?.fixtures,
        ].filter(Boolean);

        for (const list of candidates) {
          if (Array.isArray(list) && list.length > 0) {
            return normaliseFixtures(list);
          }
        }
      } catch (e) { /* try next */ }
    }
  }

  return null;
}

function normaliseFixtures(list) {
  return list.map(f => {
    const homeTeam = f.homeTeam?.name || f.home_team?.name || f.home?.name || f.homeTeam || f.home || '';
    const awayTeam = f.awayTeam?.name || f.away_team?.name || f.away?.name || f.awayTeam || f.away || '';
    const venue    = f.venue?.name || f.ground?.name || f.location || f.venue || '';
    const round    = f.round?.number || f.roundNumber || f.round || '';
    const dateStr  = f.date || f.scheduledDate || f.startDate || f.datetime || '';
    const timeStr  = f.time || f.startTime || f.kickoff || '';

    let startTime;
    try {
      startTime = dateStr && timeStr ? new Date(`${dateStr}T${timeStr}`) : new Date(dateStr);
    } catch (e) {}

    return { homeTeam, awayTeam, venue, round, startTime };
  }).filter(f => f.homeTeam && f.startTime && !isNaN(f.startTime));
}

function buildICS(fixtures) {
  const stamp = formatDTStamp(new Date());

  const events = fixtures.map((f) => {
    const isHome  = f.homeTeam.includes('Dulwich Hill');
    const homeShort = f.homeTeam.replace(' U12 Mixed', '');
    const awayShort = f.awayTeam.replace(' U12 Mixed', '');
    const summary = isHome
      ? `⚽ ${homeShort} vs ${awayShort} (Home)`
      : `⚽ ${homeShort} vs ${awayShort} (Away)`;

    const dtStart = formatDTLocal(f.startTime);
    const dtEnd   = formatDTLocal(new Date(f.startTime.getTime() + 75 * 60 * 1000));

    return [
      'BEGIN:VEVENT',
      `UID:dulwich-u12-r${f.round}-${f.startTime.toISOString().slice(0,10)}@dribl`,
      `DTSTAMP:${stamp}`,
      `SUMMARY:${summary}`,
      `DTSTART;TZID=Australia/Sydney:${dtStart}`,
      `DTEND;TZID=Australia/Sydney:${dtEnd}`,
      `LOCATION:${f.venue}`,
      `DESCRIPTION:FNSW Mixed JDL | U12 - Blue\\nRound ${f.round}\\n${f.homeTeam} vs ${f.awayTeam}`,
      'END:VEVENT',
    ].join('\r\n');
  }).join('\r\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dulwich Hill FC//U12 Mixed Live Fixtures//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${CALENDAR_NAME}`,
    'X-WR-TIMEZONE:Australia/Sydney',
    'X-PUBLISHED-TTL:PT6H',
    'BEGIN:VTIMEZONE',
    'TZID:Australia/Sydney',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+1100',
    'TZOFFSETTO:+1000',
    'TZNAME:AEST',
    'DTSTART:19700405T030000',
    'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+1000',
    'TZOFFSETTO:+1100',
    'TZNAME:AEDT',
    'DTSTART:19701004T020000',
    'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=10',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    events,
    'END:VCALENDAR',
  ].join('\r\n');
}

function formatDTStamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth()+1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function formatDTLocal(date) {
  const offset = getSydneyOffsetHours(date);
  const local  = new Date(date.getTime() + offset * 3600 * 1000);
  const pad    = n => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}${pad(local.getUTCMonth()+1)}${pad(local.getUTCDate())}T${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}00`;
}

function getSydneyOffsetHours(date) {
  const year     = date.getUTCFullYear();
  const dstEnd   = firstSundayUTC(year, 3);  // First Sunday April — clocks back to AEST
  const dstStart = firstSundayUTC(year, 9);  // First Sunday October — clocks forward to AEDT
  return (date >= dstStart || date < dstEnd) ? 11 : 10;
}

function firstSundayUTC(year, month) {
  const d = new Date(Date.UTC(year, month, 1));
  d.setUTCDate(1 + (7 - d.getUTCDay()) % 7);
  return d;
}

// ─── Fallback fixtures ────────────────────────────────────────────────────────
// Used when live scraping fails. All times stored as UTC equivalents of Sydney local time.
const FALLBACK_FIXTURES = [
  { round: 5,  homeTeam: 'Dulwich Hill FC U12 Mixed',                       awayTeam: 'Inter Lions FC U12 Mixed',                  startTime: new Date('2026-04-11T04:30:00Z'), venue: 'Fraser Park (Synthetic) - Half 02' },
  { round: 6,  homeTeam: 'Manly Warringah FA U12 Mixed',                    awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-04-19T00:30:00Z'), venue: 'Cromer Park Field 4 - Half 02' },
  { round: 7,  homeTeam: 'Dulwich Hill FC U12 Mixed',                       awayTeam: 'Hawkesbury City FC U12 Mixed',              startTime: new Date('2026-04-26T01:00:00Z'), venue: 'David Bertenshaw Field Field 2 - Half 02' },
  { round: 8,  homeTeam: 'St George City FA U12 Mixed',                     awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-05-03T00:30:00Z'), venue: 'Penshurst Park (Synthetic) - Half 02' },
  { round: 9,  homeTeam: 'Dulwich Hill FC U12 Mixed',                       awayTeam: 'Western City Rangers FC U12 Mixed',         startTime: new Date('2026-05-10T01:00:00Z'), venue: 'Arlington Oval (Synthetic) - Half 02' },
  { round: 10, homeTeam: 'Central West FC U12 Mixed',                       awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-05-17T02:00:00Z'), venue: 'Proctor Park Field 2 - Half 02' },
  { round: 11, homeTeam: 'Dulwich Hill FC U12 Mixed',                       awayTeam: 'Bonnyrigg White Eagles FC U12 Mixed',       startTime: new Date('2026-05-24T01:00:00Z'), venue: 'Arlington Oval (Synthetic) - Half 02' },
  { round: 12, homeTeam: 'Eastern Suburbs FA U12 Mixed',                    awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-05-31T00:30:00Z'), venue: 'Heffron Park Field 1 - Half 02 (Synthetic)' },
  { round: 13, homeTeam: 'Dulwich Hill FC U12 Mixed',                       awayTeam: 'Blacktown Spartans FC U12 Mixed',           startTime: new Date('2026-06-07T01:00:00Z'), venue: 'Arlington Oval (Synthetic) - Half 02' },
  { round: 14, homeTeam: 'Macarthur FA U12 Mixed',                          awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-06-13T04:00:00Z'), venue: 'Lynwood Stadium Field 2 - Half 01' },
  { round: 15, homeTeam: 'Sutherland Shire Football Association U12 Mixed', awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-06-20T00:00:00Z'), venue: 'Harrie Dening Centre Field 2 - Half 02' },
  { round: 16, homeTeam: 'Dulwich Hill FC U12 Mixed',                       awayTeam: 'Manly Warringah FA U12 Mixed',              startTime: new Date('2026-06-28T01:00:00Z'), venue: 'Arlington Oval (Synthetic) - Half 02' },
  { round: 17, homeTeam: 'Sydney University SFC U12 Mixed',                 awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-07-05T00:30:00Z'), venue: 'Gunyama Park (Synthetic) - Half 02' },
  { round: 18, homeTeam: 'Granville Rage U12 Mixed',                        awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-07-12T01:00:00Z'), venue: 'Ray Marshall Reserve Field 1 - Half 02' },
  { round: 19, homeTeam: 'Hawkesbury City FC U12 Mixed',                    awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-07-18T01:30:00Z'), venue: 'David Bertenshaw Field Field 1 - Half 02' },
  { round: 20, homeTeam: 'Dulwich Hill FC U12 Mixed',                       awayTeam: 'Mounties Wanderers FC U12 Mixed',           startTime: new Date('2026-07-26T01:00:00Z'), venue: 'Arlington Oval (Synthetic) - Half 02' },
  { round: 21, homeTeam: 'Fraser Park FC U12 Mixed',                        awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-08-02T00:30:00Z'), venue: 'Fraser Park (Synthetic) - Half 02' },
  { round: 22, homeTeam: 'Western City Rangers FC U12 Mixed',               awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-08-09T03:15:00Z'), venue: 'Popondetta Park Field 2 - Half 02 (Synthetic)' },
  { round: 23, homeTeam: 'Dulwich Hill FC U12 Mixed',                       awayTeam: 'Hakoah Sydney City East FC U12 Mixed',      startTime: new Date('2026-08-16T01:00:00Z'), venue: 'Arlington Oval (Synthetic) - Half 02' },
  { round: 24, homeTeam: 'Blacktown Districts SFA U12 Mixed',               awayTeam: 'Dulwich Hill FC U12 Mixed',                 startTime: new Date('2026-08-23T00:30:00Z'), venue: 'Blacktown Football Park Field 1 - Half 02 (Synthetic)' },
  { round: 25, homeTeam: 'Dulwich Hill FC U12 Mixed',                       awayTeam: 'Macarthur FA U12 Mixed',                    startTime: new Date('2026-08-30T01:00:00Z'), venue: 'Arlington Oval (Synthetic) - Half 02' },
];

// ─── Vercel serverless handler ────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="dulwich-hill-u12.ics"');
  res.setHeader('Cache-Control', 'public, max-age=21600');

  if (cache.ics && cache.fetchedAt && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) {
    return res.status(200).send(cache.ics);
  }

  let fixtures = null;

  try {
    console.log('Fetching from nswcomps.dribl.com...');
    const html = await fetchPage(FIXTURES_URL);
    console.log(`Got ${html.length} bytes`);
    fixtures = parseFixtures(html);
    console.log(fixtures ? `Parsed ${fixtures.length} live fixtures` : 'Parse failed, using fallback');
  } catch (e) {
    console.error('Scrape error:', e.message);
  }

  if (!fixtures || fixtures.length === 0) fixtures = FALLBACK_FIXTURES;

  const ics = buildICS(fixtures);
  cache = { ics, fetchedAt: Date.now() };

  return res.status(200).send(ics);
};
