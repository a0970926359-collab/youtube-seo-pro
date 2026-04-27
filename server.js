import express from 'express';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'identity',
  'DNT': '1',
  'Connection': 'keep-alive',
};

// ─── Video ID Extractor ────────────────────────────────────────────────────────
function extractVideoId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  // bare ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

// ─── Stop Words ────────────────────────────────────────────────────────────────
const ZH_STOP = new Set([
  '的','了','是','在','我','有','和','就','不','人','都','一','上','也','很','她','他','它',
  '這','那','你','們','個','什','麼','怎','為','但','而','或','及','與','對','從','到','把',
  '被','讓','用','來','去','說','看','可','以','沒','因','所','如','果','還','已','真','只',
  '然','後','樣','哦','啊','嗎','呢','吧','哈','嗯','喔','唷','耶','欸','嘛','啦','喂','哇',
  '再','要','好','更','最','些','多','大','小','中','新','全','老','後','前','自','太',
]);
const EN_STOP = new Set([
  'a','an','the','is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','can','to','of','in','for','on','with',
  'at','by','from','up','about','into','through','and','but','or','not','just','i','me','my',
  'we','our','you','your','he','him','his','she','her','it','its','they','them','their',
  'what','which','who','this','that','these','those','how','all','each','more','most','other',
  'some','no','if','then','as','when','where','why','get','go','come','see','know','think',
  'give','take','make','say','tell','want','need','feel','put','keep','let','show','hear',
  'play','run','move','live','write','read','watch','follow','stop','create','build','stay',
  'so','then','than','too','very','here','there','again','once','its','s','t','re','ve','ll',
]);

// ─── Tokeniser ─────────────────────────────────────────────────────────────────
function tokenize(text) {
  if (!text) return [];
  const tokens = [];

  // English words (≥2 chars, not stop)
  const enWords = text.match(/[a-zA-Z]{2,}/g) || [];
  tokens.push(...enWords.map(w => w.toLowerCase()).filter(w => !EN_STOP.has(w)));

  // Chinese n-grams (bi + tri)
  const zh = text.replace(/[^一-鿿㐀-䶿]/g, '');
  for (let i = 0; i < zh.length - 1; i++) {
    const bi = zh.slice(i, i + 2);
    if (!ZH_STOP.has(bi[0]) && !ZH_STOP.has(bi[1])) tokens.push(bi);
    if (i < zh.length - 2) {
      const tri = zh.slice(i, i + 3);
      if (!ZH_STOP.has(tri[0]) && !ZH_STOP.has(tri[2])) tokens.push(tri);
    }
  }
  return tokens;
}

// ─── Keyword Extraction ────────────────────────────────────────────────────────
function extractKeywords(title, description = '') {
  const freq = new Map();

  const add = (tokens, weight) => {
    tokens.forEach(t => freq.set(t, (freq.get(t) || 0) + weight));
  };

  add(tokenize(title), 5);
  add(tokenize(description.slice(0, 3000)), 1);

  const scored = [...freq.entries()].map(([word, score]) => ({
    word,
    score: score * (word.length >= 4 ? 1.6 : word.length === 3 ? 1.25 : 1),
    inTitle: title.includes(word),
  }));

  scored.sort((a, b) => b.score - a.score);

  // Remove redundant sub-strings
  const result = [];
  for (const item of scored) {
    if (!result.some(r => r.word !== item.word && r.word.includes(item.word))) {
      result.push(item);
    }
    if (result.length >= 25) break;
  }

  // Normalise score to 0-100
  const max = result[0]?.score || 1;
  return result.map(r => ({ ...r, relevance: Math.round((r.score / max) * 100) }));
}

// ─── Title SEO Analysis ────────────────────────────────────────────────────────
function analyzeTitleSEO(title, keywords = []) {
  const issues = [];
  const good = [];
  let score = 0;

  // Length (25pts)
  const len = title.length;
  if (len >= 40 && len <= 70) { score += 25; good.push(`標題長度完美（${len} 字元）`); }
  else if (len >= 30) { score += 15; issues.push({ type: 'warn', msg: `標題稍短（${len} 字），建議 40-70 字元` }); }
  else if (len > 70 && len <= 90) { score += 18; issues.push({ type: 'warn', msg: `標題略長（${len} 字），YouTube 顯示時可能被截斷` }); }
  else if (len > 90) { score += 8; issues.push({ type: 'bad', msg: `標題過長（${len} 字），請精簡至 70 字以內` }); }
  else { score += 5; issues.push({ type: 'bad', msg: `標題太短（${len} 字），需要更完整的描述` }); }

  // Power words (20pts)
  const powerWords = ['教學', '攻略', '完整', '入門', '新手', '秘訣', '技巧', '免費', '最新', '必看', '推薦', '詳解', '實戰', '零基礎', 'tutorial', 'guide', 'complete', 'ultimate', 'best', 'how to', 'tips'];
  const found = powerWords.filter(p => title.toLowerCase().includes(p.toLowerCase()));
  if (found.length >= 2) { score += 20; good.push(`含多個強力詞：${found.slice(0,3).join('、')}`); }
  else if (found.length === 1) { score += 12; good.push(`含強力詞：${found[0]}`); issues.push({ type: 'info', msg: '可再加入「完整」「新手必看」等詞提升點擊率' }); }
  else { issues.push({ type: 'warn', msg: '建議加入「教學」「完整攻略」「入門指南」等強力詞彙' }); }

  // Numbers (15pts)
  if (/[0-9０-９]/.test(title)) { score += 15; good.push('含數字，增加可信度與點擊率'); }
  else { issues.push({ type: 'info', msg: '加入數字（「5個技巧」「30天學會」）可提升點擊率約 30%' }); }

  // Year (10pts)
  if (/202[4-9]/.test(title)) { score += 10; good.push('含年份，展示時效性'); }
  else { issues.push({ type: 'info', msg: `加入 ${new Date().getFullYear()} 可讓觀眾知道內容是最新的` }); }

  // Brackets / structure (10pts)
  if (/[【】\[\]（）()]/.test(title)) { score += 10; good.push('使用括號強化結構感'); }
  else { issues.push({ type: 'info', msg: '使用【】或 [] 分隔關鍵資訊，視覺效果更佳' }); }

  // Top keyword in title (20pts)
  if (keywords.length > 0) {
    const topKw = keywords[0].word;
    if (title.includes(topKw)) { score += 20; good.push(`核心關鍵字「${topKw}」在標題中`); }
    else { issues.push({ type: 'bad', msg: `核心關鍵字「${topKw}」未出現在標題，嚴重影響搜尋排名` }); }
  }

  return { score: Math.min(score, 100), issues, good };
}

// ─── Title Suggestion Generator ────────────────────────────────────────────────
function generateTitleSuggestions(title, keywords) {
  const kws = keywords.map(k => k.word);
  const mk = kws[0] || title.slice(0, 5);
  const sk = kws[1] || '';
  const yr = new Date().getFullYear();

  return [
    `【完整教學】${mk}${sk ? ' × ' + sk : ''}：新手零基礎也能快速上手！`,
    `${yr} 最新｜${mk}入門到精通完整攻略（附實戰示範）`,
    `我花了30天實測${mk}，3個關鍵技巧讓你少走彎路`,
    `${mk}完整教學：從零開始到${sk || '精通'}的詳細步驟`,
    `99%的人不知道的${mk}秘訣！看完直接省下大量時間`,
    `${mk}新手必看！這${kws.length > 2 ? kws.length : 5}個技巧讓你快速突破`,
    `為什麼你的${mk}學不好？原來這幾個錯誤你都犯了`,
    `${yr}年最有效的${mk}方法｜${sk || '完整'}教學 Step by Step`,
  ].map(t => ({
    text: t,
    score: analyzeTitleSEO(t, keywords).score,
  })).sort((a, b) => b.score - a.score);
}

// ─── Tag Generator ─────────────────────────────────────────────────────────────
function generateTagSuggestions(title, description, keywords) {
  const kws = keywords.map(k => k.word);
  const mk = kws[0] || title.slice(0, 5);
  const yr = new Date().getFullYear();

  const tags = new Set([
    mk, ...kws.slice(0, 10),
    `${mk}教學`, `${mk}入門`, `${mk}推薦`, `${mk}${yr}`,
    `學${mk}`, `如何${mk}`, `${mk}技巧`, `${mk}方法`,
    `${mk}攻略`, `${mk}完整版`, `${mk}新手`, `${mk}零基礎`,
    '教學', 'YouTube', '學習', `${yr}`, '新手入門', '完整教學',
    '免費教學', '實戰', '攻略',
  ]);

  return [...tags].filter(t => t && t.length >= 2 && t.length <= 30).slice(0, 25);
}

// ─── SEO Score Calculator ──────────────────────────────────────────────────────
function calcSEOScore(title, description, tags, keywords) {
  let score = 0;
  const len = title.length;

  // Title (30)
  if (len >= 40 && len <= 70) score += 30;
  else if (len >= 30) score += 18;
  else if (len > 0) score += 8;

  // Description (25)
  if (description.length >= 500) score += 25;
  else if (description.length >= 200) score += 18;
  else if (description.length >= 50) score += 10;
  else if (description.length > 0) score += 5;

  // Tags (25)
  const tc = tags.length;
  if (tc >= 15) score += 25;
  else if (tc >= 8) score += 17;
  else if (tc >= 3) score += 10;
  else if (tc > 0) score += 5;

  // Keyword consistency (20)
  const kw = keywords[0]?.word || '';
  if (kw) {
    if (title.includes(kw)) score += 10;
    if (description.includes(kw)) score += 5;
    if (tags.some(t => t.includes(kw))) score += 5;
  } else {
    score += 10;
  }

  return Math.min(score, 100);
}

// ─── API Route ─────────────────────────────────────────────────────────────────
app.get('/api/analyze', async (req, res) => {
  try {
    const rawUrl = (req.query.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: '請提供 YouTube 影片連結' });

    const videoId = extractVideoId(rawUrl);
    if (!videoId) return res.status(400).json({ error: '無效的 YouTube 連結，請確認格式' });

    // 1. oEmbed (always works for public videos)
    let oembed;
    try {
      const oRes = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        { headers: HEADERS, signal: AbortSignal.timeout(8000) }
      );
      if (!oRes.ok) throw new Error(`HTTP ${oRes.status}`);
      oembed = await oRes.json();
    } catch {
      return res.status(400).json({ error: '無法取得影片資訊，請確認影片是否公開' });
    }

    // 2. Page scrape for richer data (best-effort)
    let description = '';
    let existingTags = [];
    let viewCount = null;
    let category = '';
    let uploadDate = '';

    try {
      const pageRes = await fetch(
        `https://www.youtube.com/watch?v=${videoId}&hl=zh-TW`,
        { headers: HEADERS, signal: AbortSignal.timeout(12000) }
      );
      const html = await pageRes.text();
      const $ = cheerio.load(html);

      description =
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') || '';

      // Parse ytInitialData embedded JSON
      for (const el of $('script').toArray()) {
        const src = $(el).html() || '';
        if (!src.includes('ytInitialData') || src.length < 500) continue;

        const descM = src.match(/"shortDescription"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (descM) {
          description = descM[1]
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            .slice(0, 4000);
        }

        const viewM = src.match(/"viewCount"\s*:\s*"(\d+)"/);
        if (viewM) viewCount = parseInt(viewM[1]);

        const kwM = src.match(/"keywords"\s*:\s*\[([^\]]+)\]/);
        if (kwM) {
          existingTags = (kwM[1].match(/"([^"]{1,50})"/g) || [])
            .map(s => s.replace(/"/g, ''))
            .filter(Boolean);
        }

        const catM = src.match(/"category"\s*:\s*"([^"]+)"/);
        if (catM) category = catM[1];

        const dateM = src.match(/"uploadDate"\s*:\s*"([^"]+)"/);
        if (dateM) uploadDate = dateM[1].slice(0, 10);

        break;
      }
    } catch (e) {
      console.warn('Page scrape skipped:', e.message.slice(0, 80));
    }

    // 3. Analysis
    const extractedKeywords = extractKeywords(oembed.title, description);
    const titleAnalysis = analyzeTitleSEO(oembed.title, extractedKeywords);
    const titleSuggestions = generateTitleSuggestions(oembed.title, extractedKeywords);
    const tagSuggestions = generateTagSuggestions(oembed.title, description, extractedKeywords);
    const seoScore = calcSEOScore(oembed.title, description, existingTags, extractedKeywords);

    res.json({
      videoId,
      title: oembed.title,
      author: oembed.author_name,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      description: description.slice(0, 800),
      existingTags: existingTags.slice(0, 30),
      category,
      viewCount,
      uploadDate,
      extractedKeywords,
      titleAnalysis,
      titleSuggestions,
      tagSuggestions,
      seoScore,
    });

  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: '分析失敗：' + err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  🚀 YouTube SEO 神器 Pro 已啟動`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
});
