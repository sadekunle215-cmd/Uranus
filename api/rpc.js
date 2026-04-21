export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Retry a fetch with exponential backoff
async function fetchWithRetry(url, options, retries = 3, baseDelay = 400) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      // Retry on 429 rate-limit or 5xx server errors
      if (res.status === 429 || res.status >= 500) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        lastErr = new Error(`RPC HTTP ${res.status}`);
        continue;
      }

      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const heliusUrl = process.env.HELIUS_RPC_URL;
  if (!heliusUrl) {
    console.error('[rpc] HELIUS_RPC_URL env var is not set');
    return res.status(500).json({ error: 'RPC not configured' });
  }

  try {
    const rawBody = await getRawBody(req);

    // Log method for debugging (strip sensitive data)
    try {
      const parsed = JSON.parse(rawBody);
      console.log(`[rpc] method=${parsed.method} id=${parsed.id}`);
    } catch {}

    const response = await fetchWithRetry(heliusUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    });

    const data = await response.json();

    // Surface RPC-level errors clearly in logs
    if (data?.error) {
      console.error(`[rpc] RPC error:`, JSON.stringify(data.error));
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('[rpc] Proxy error:', err.message);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'RPC request timed out', detail: 'Helius did not respond in 30s' });
    }
    return res.status(500).json({ error: 'RPC proxy error', detail: err.message });
  }
}
