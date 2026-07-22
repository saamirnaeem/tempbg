import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

// Initialize Supabase Server Client if env vars are set
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

let supabase: SupabaseClient | null = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('Server connected to Supabase');
  } catch (err) {
    console.warn('Failed to initialize server-side Supabase client:', err);
  }
}

// In-Memory store fallback (ensures immediate 100% working links even before Supabase is connected)
interface ShortLink {
  slug: string;
  destinationUrl: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImageUrl?: string;
  userId: string;
  createdAt: number;
}

interface ClickLog {
  id?: number;
  slug: string;
  timestamp: number;
  userAgent: string;
  country: string;
  userId: string;
}

const memoryLinks = new Map<string, ShortLink>();
const memoryLogs: ClickLog[] = [];

// API: Scrape Metadata for Open Graph preview
app.get('/api/scrape-metadata', async (req, res) => {
  const targetUrl = req.query.url as string;
  if (!targetUrl) {
    res.status(400).json({ error: 'Missing url query parameter' });
    return;
  }

  try {
    let normalizedUrl = targetUrl;
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    const response = await fetch(normalizedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();

    const getMetaTag = (htmlText: string, propertyOrName: string): string => {
      const regex = new RegExp(
        `<meta[^>]*(?:property|name)=["']${propertyOrName}["'][^>]*content=["']([^"']*)["']`,
        'i'
      );
      const match = htmlText.match(regex);
      if (match) return match[1];

      const reverseRegex = new RegExp(
        `<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${propertyOrName}["']`,
        'i'
      );
      const reverseMatch = htmlText.match(reverseRegex);
      return reverseMatch ? reverseMatch[1] : '';
    };

    const getTitleTag = (htmlText: string): string => {
      const match = htmlText.match(/<title[^>]*>([^<]*)<\/title>/i);
      return match ? match[1].trim() : '';
    };

    const ogTitle = getMetaTag(html, 'og:title') || getTitleTag(html);
    const ogDescription = getMetaTag(html, 'og:description') || getMetaTag(html, 'description');
    const ogImageUrl = getMetaTag(html, 'og:image');

    res.json({
      title: ogTitle || '',
      description: ogDescription || '',
      imageUrl: ogImageUrl || ''
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to scrape metadata', details: error.message });
  }
});

// API: Register or Sync Link with backend memory store for fast redirects
app.post('/api/sync-link', (req, res) => {
  const link: ShortLink = req.body;
  if (!link || !link.slug || !link.destinationUrl) {
    res.status(400).json({ error: 'Invalid link payload' });
    return;
  }
  memoryLinks.set(link.slug.toLowerCase(), link);
  res.json({ success: true });
});

// API: Public Image Proxy for Base64 Data URLs or social previews
app.get('/api/image/:slug', async (req, res) => {
  const { slug } = req.params;
  const lowerSlug = slug.replace(/\.(jpg|jpeg|png|webp|gif|svg)$/i, '').toLowerCase();

  let ogImageUrl = '';
  let ogTitle = '';
  let ogDescription = '';

  if (supabase) {
    try {
      const { data } = await supabase.from('links').select('*').eq('slug', lowerSlug).single();
      if (data) {
        ogImageUrl = (data.og_image_url || data.ogImageUrl || '').trim();
        ogTitle = data.og_title || data.ogTitle || '';
        ogDescription = data.og_description || data.ogDescription || '';
      }
    } catch (e) {}
  }

  if (!ogImageUrl && memoryLinks.has(lowerSlug)) {
    const mem = memoryLinks.get(lowerSlug);
    ogImageUrl = (mem?.ogImageUrl || '').trim();
    ogTitle = mem?.ogTitle || '';
    ogDescription = mem?.ogDescription || '';
  }

  if (ogImageUrl) {
    // Handle Base64 Data URLs
    if (ogImageUrl.startsWith('data:image/')) {
      const matches = ogImageUrl.match(/^data:(image\/[a-zA-Z0-9+\-]+);base64,(.+)$/);
      if (matches) {
        const mimeType = matches[1] || 'image/jpeg';
        const base64Data = matches[2];
        const buffer = Buffer.from(base64Data, 'base64');
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', buffer.length.toString());
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(buffer);
        return;
      }
    }

    // Handle external HTTP image proxy
    if (/^https?:\/\//i.test(ogImageUrl)) {
      try {
        const imgRes = await fetch(ogImageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
          }
        });
        if (imgRes.ok) {
          const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
          const arrayBuffer = await imgRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Length', buffer.length.toString());
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.send(buffer);
          return;
        }
      } catch (e) {}
      res.redirect(301, ogImageUrl);
      return;
    }
  }

  // Fallback generated SVG card
  const safeTitle = (ogTitle || 'TrimPro Short Link').replace(/[<>&'"]/g, '');
  const safeDesc = (ogDescription || 'Click to open target destination').replace(/[<>&'"]/g, '');
  const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0f172a"/>
        <stop offset="50%" stop-color="#1e1b4b"/>
        <stop offset="100%" stop-color="#311042"/>
      </linearGradient>
      <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#6366f1"/>
        <stop offset="100%" stop-color="#a855f7"/>
      </linearGradient>
    </defs>
    <rect width="1200" height="630" fill="url(#bg)"/>
    <circle cx="1000" cy="150" r="300" fill="#6366f1" opacity="0.15"/>
    <circle cx="150" cy="500" r="250" fill="#a855f7" opacity="0.12"/>
    <rect x="80" y="80" width="1040" height="470" rx="24" fill="#ffffff" fill-opacity="0.05" stroke="#ffffff" stroke-opacity="0.1" stroke-width="2"/>
    <rect x="120" y="130" width="160" height="44" rx="22" fill="url(#accent)"/>
    <text x="200" y="158" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="700" fill="#ffffff" text-anchor="middle">TrimPro</text>
    <text x="120" y="260" font-family="system-ui, -apple-system, sans-serif" font-size="48" font-weight="800" fill="#ffffff">${safeTitle.length > 50 ? safeTitle.substring(0, 48) + '...' : safeTitle}</text>
    <text x="120" y="330" font-family="system-ui, -apple-system, sans-serif" font-size="26" font-weight="400" fill="#94a3b8">${safeDesc.length > 80 ? safeDesc.substring(0, 77) + '...' : safeDesc}</text>
    <line x1="120" y1="440" x2="1080" y2="440" stroke="#ffffff" stroke-opacity="0.1" stroke-width="2"/>
    <text x="120" y="485" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="600" fill="#818cf8">Click to open link &#8594;</text>
  </svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(svg);
});

// API: Delete short link securely
app.post('/api/delete-link', async (req, res) => {
  const { slug, userId } = req.body;
  if (!slug || !userId) {
    res.status(400).json({ error: 'Missing slug or userId' });
    return;
  }

  const lowerSlug = slug.toLowerCase();

  // Try Supabase if configured
  if (supabase) {
    try {
      const { data, error } = await supabase.from('links').select('*').eq('slug', lowerSlug).single();
      if (!error && data) {
        if (data.user_id !== userId && data.userId !== userId) {
          res.status(403).json({ error: 'Unauthorized: You do not own this link' });
          return;
        }
        await supabase.from('links').delete().eq('slug', lowerSlug);
      }
    } catch (e) {
      console.warn('Supabase delete error:', e);
    }
  }

  // Memory store cleanup
  if (memoryLinks.has(lowerSlug)) {
    const link = memoryLinks.get(lowerSlug);
    if (link && link.userId !== userId) {
      res.status(403).json({ error: 'Unauthorized: You do not own this link' });
      return;
    }
    memoryLinks.delete(lowerSlug);
  }

  res.json({ success: true, message: 'Link deleted successfully' });
});

// Redirect Handler
app.get('/:slug', async (req, res, next) => {
  const { slug } = req.params;

  if (
    slug.includes('.') || 
    slug.startsWith('api') || 
    slug.startsWith('src') || 
    slug.startsWith('node_modules') || 
    slug.startsWith('assets') || 
    slug === 'index.html' || 
    slug === 'favicon.ico'
  ) {
    return next();
  }

  const lowerSlug = slug.toLowerCase();
  let linkData: ShortLink | null = null;

  // 1. Try Supabase lookup
  if (supabase) {
    try {
      const { data, error } = await supabase.from('links').select('*').eq('slug', lowerSlug).single();
      if (!error && data) {
        linkData = {
          slug: data.slug,
          destinationUrl: data.destination_url || data.destinationUrl,
          ogTitle: data.og_title || data.ogTitle,
          ogDescription: data.og_description || data.ogDescription,
          ogImageUrl: data.og_image_url || data.ogImageUrl,
          userId: data.user_id || data.userId,
          createdAt: Number(data.created_at || data.createdAt || Date.now())
        };
      }
    } catch (e) {
      console.warn('Supabase lookup error:', e);
    }
  }

  // 2. Fallback to memory store
  if (!linkData && memoryLinks.has(lowerSlug)) {
    linkData = memoryLinks.get(lowerSlug) || null;
  }

  if (linkData && linkData.destinationUrl) {
    const destinationUrl = linkData.destinationUrl;
    const userAgent = (req.headers['user-agent'] || 'Unknown').substring(0, 512);
    const country = ((req.headers['x-vercel-ip-country'] || req.headers['cf-ipcountry'] || 'PK') as string).substring(0, 10);

    const logEntry: ClickLog = {
      slug: lowerSlug,
      timestamp: Date.now(),
      userAgent,
      country,
      userId: linkData.userId || 'Unknown'
    };

    // Store log in Supabase or memory
    if (supabase) {
      try {
        await supabase.from('click_logs').insert([{
          slug: logEntry.slug,
          timestamp: logEntry.timestamp,
          user_agent: logEntry.userAgent,
          country: logEntry.country,
          user_id: logEntry.userId
        }]);
      } catch (e) {
        console.warn('Failed to save click log in Supabase:', e);
      }
    }
    memoryLogs.push(logEntry);

    const escapeHtml = (text: string) => {
      if (!text) return '';
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    const title = escapeHtml(linkData.ogTitle || 'Redirecting...');
    const description = escapeHtml(linkData.ogDescription || 'Please wait while we redirect you.');
    
    // Resolve public image URL for Facebook Crawler
    const protocol = (req.headers['x-forwarded-proto'] || 'https') as string;
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '') as string;
    const origin = `${protocol}://${host}`;

    let rawImageUrl = linkData.ogImageUrl || '';
    let finalImageUrl = '';

    if (rawImageUrl.startsWith('data:image/')) {
      finalImageUrl = `${origin}/api/image/${lowerSlug}.jpg`;
    } else if (/^https?:\/\//i.test(rawImageUrl)) {
      finalImageUrl = rawImageUrl;
    } else if (rawImageUrl.startsWith('/')) {
      finalImageUrl = `${origin}${rawImageUrl}`;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  
  <!-- Open Graph / Facebook Meta Tags -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(destinationUrl)}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  ${finalImageUrl ? `
  <meta property="og:image" content="${escapeHtml(finalImageUrl)}">
  <meta property="og:image:url" content="${escapeHtml(finalImageUrl)}">
  <meta property="og:image:secure_url" content="${escapeHtml(finalImageUrl)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/jpeg">
  ` : ''}

  <!-- Twitter Meta Tags -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:url" content="${escapeHtml(destinationUrl)}">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  ${finalImageUrl ? `<meta name="twitter:image" content="${escapeHtml(finalImageUrl)}">` : ''}

  <script>
    window.location.href = "${destinationUrl.replace(/"/g, '\\"')}";
  </script>
  <noscript>
    <meta http-equiv="refresh" content="0; url=${escapeHtml(destinationUrl)}">
  </noscript>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #fafafa; color: #333;">
  <div style="text-align: center; padding: 2rem;">
    <h2 style="font-weight: 500; margin-bottom: 0.5rem;">Redirecting...</h2>
    <p style="color: #666; margin-bottom: 1.5rem;">You are being redirected to: <a href="${escapeHtml(destinationUrl)}" style="color: #2563eb; text-decoration: none; word-break: break-all;">${escapeHtml(destinationUrl)}</a></p>
    <div style="border: 3px solid #f3f3f3; border-top: 3px solid #2563eb; border-radius: 50%; width: 24px; height: 24px; animation: spin 1s linear infinite; margin: 0 auto;"></div>
  </div>
  <style>
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</body>
</html>`);
    return;
  }

  next();
});

// Setup Vite / Static Serving
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
