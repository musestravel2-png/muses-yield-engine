import axios from 'axios';
import { Groq } from 'groq-sdk';

// =====================================================================
// MUSES · MASTER RATES ENGINE v2 — Σύμβουλος τιμολόγησης (ανεξάρτητη μηχανή)
// Συμβατή με τις υπάρχουσες κλήσεις (villaName, baselinePrice, month, assetScore[, regionalOccupancyProxy]).
// ΝΕΑ προαιρετικά πεδία ανά item:
//   month: "2027-07" (ή "07/2027")               → ο μήνας που τιμολογούμε (απαραίτητος για ακρίβεια)
//   market: { zone, asOf, occ, occLY, adr, adrLY, musesOcc, musesAdr }   ← από KEYDATA_SIGNALS.json (πληρότητες σε %)
//   holidays: { "Γερμανία": 31, "Ολλανδία": 9, ... }                      ← ημέρες διακοπών ανά χώρα στον μήνα
//   sourceMarkets: { "Γερμανία": 0.35, "Ηνωμένο Βασίλειο": 0.25, ... }    ← μερίδιο πελατών ανά χώρα (προαιρετικό)
//   beyondPrice: 420                                                     ← πρόταση Beyond για σύγκριση
// Κανόνας ειλικρίνειας: χωρίς ΠΡΑΓΜΑΤΙΚΑ δεδομένα δεν προτείνεται τιμή (action: INSUFFICIENT_DATA).
// =====================================================================

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const AVIATION_API_KEY = process.env.AVIATION_API_KEY;
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
const ENGINE_VERSION = 'v2.1';                                   // ← φαίνεται στο μήνυμα του Master Rates· ανοίγοντας το URL στον browser
const MUSES_API_KEY = process.env.MUSES_API_KEY || '';          // αν οριστεί, απαιτείται header x-muses-key

const DATASETS = {
    airbnb: process.env.APIFY_AIRBNB_DATASET_ID || '',
    booking: process.env.APIFY_BOOKING_DATASET_ID || '',
    vrbo: process.env.APIFY_VRBO_DATASET_ID || '',
    trends: process.env.APIFY_TRENDS_DATASET_ID || ''
};

let globalCache = { flights: { data: null, timestamp: 0 }, market: { data: null, timestamp: 0 } };
const CACHE_TTL = 12 * 60 * 60 * 1000;
const OLLAMA_MODELS_CASCADE = ['gpt-oss:120b', 'deepseek-v4-flash', 'mistral-large-3:675b'];

async function getResilientAISummary(prompt) {
    if (OLLAMA_API_KEY) {
        for (const model of OLLAMA_MODELS_CASCADE) {
            try {
                const r = await axios.post('https://ollama.com/api/chat', { model, messages: [{ role: "user", content: prompt }], stream: false },
                    { headers: { 'Authorization': `Bearer ${OLLAMA_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 3500 });
                const content = r.data?.message?.content; if (content) return content;
            } catch (e) { console.error(`Ollama model ${model} failed:`, e.message); }
        }
    }
    try {
        const c = await groq.chat.completions.create({ messages: [{ role: "user", content: prompt }], model: "openai/gpt-oss-20b" });
        const content = c.choices[0]?.message?.content; if (content) return content;
    } catch (e) { console.error('Groq fallback failed:', e.message); }
    return null;
}

// ── Βοηθητικά ──
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
function parseMonth(m) {           // "2027-07" | "07/2027" | "7/2027" → {y, m}
    const s = String(m || '').trim(); let r = s.match(/^(\d{4})-(\d{1,2})$/); if (r) return { y: +r[1], m: +r[2] };
    r = s.match(/^(\d{1,2})[\/.-](\d{4})$/); if (r) return { y: +r[2], m: +r[1] }; return null;
}
function leadDays(pm) { if (!pm) return null; const mid = new Date(pm.y, pm.m - 1, 15); return Math.round((mid - new Date()) / 86400000); }

// ── Σήματα (κάθε σήμα: τιμή -1…+1, βάρος, και αν είναι πραγματικό δεδομένο) ──
function buildSignals(item, ctx) {
    const S = [], pm = parseMonth(item.month), lead = leadDays(pm);
    const near = lead === null ? 0.5 : (lead <= 30 ? 1 : lead <= 60 ? 0.5 : 0);   // πτήσεις/ανταγωνιστές: αξία μόνο για κοντινούς μήνες
    const mk = item.market || {};
    const occ = num(mk.occ), occLY = num(mk.occLY), adr = num(mk.adr), mOcc = num(mk.musesOcc), mAdr = num(mk.musesAdr);
    let freshness = null;
    if (mk.asOf) { const d = new Date(mk.asOf); if (!isNaN(d)) freshness = Math.round((new Date() - d) / 86400000); }
    const fresh = freshness === null ? 1 : (freshness <= 30 ? 1 : freshness <= 60 ? 0.6 : 0.3);
    // 1. Ρυθμός αγοράς έναντι πέρσι (KeyData)
    if (occ !== null && occLY !== null && occLY > 0) {
        const pace = occ / occLY - 1;
        S.push({ key: 'marketPace', label: 'Ρυθμός αγοράς έναντι πέρσι', value: clamp(pace / 0.4, -1, 1), weight: 0.35 * fresh, real: true,
                 text: `Η αγορά${mk.zone ? ' ' + mk.zone : ''} έχει κλείσει ${occ.toFixed(1)}% έναντι ${occLY.toFixed(1)}% πέρσι (${pace >= 0 ? '+' : ''}${Math.round(pace * 100)}%)` });
    }
    // 2. Πόσο γρήγορα γεμίζουμε εμείς έναντι αγοράς (MPI)
    if (occ !== null && occ > 0 && mOcc !== null) {
        const mpi = mOcc / occ;
        S.push({ key: 'ourPace', label: 'Ρυθμός μας έναντι αγοράς', value: clamp((mpi - 1) / 0.5, -1, 1), weight: 0.2 * fresh, real: true,
                 text: `Γεμίζουμε ${mpi >= 1 ? (mpi).toFixed(1) + '× γρηγορότερα' : (1 / Math.max(mpi, 0.01)).toFixed(1) + '× πιο αργά'} από την αγορά (${mOcc.toFixed(1)}% έναντι ${occ.toFixed(1)}%)` });
    }
    // 3. Αργίες χωρών-πελατών στον μήνα
    if (item.holidays && typeof item.holidays === 'object' && Object.keys(item.holidays).length) {
        const w = item.sourceMarkets && Object.keys(item.sourceMarkets).length ? item.sourceMarkets : null;
        let score = 0, tot = 0;
        Object.entries(item.holidays).forEach(([c, days]) => { const share = w ? (num(w[c]) || 0) : 1; score += share * clamp((num(days) || 0) / 30, 0, 1); tot += share; });
        if (!w) tot = Math.max(tot, 12);                          // χωρίς μερίδια: ως ποσοστό των ~12+ αγορών που παρακολουθούμε
        const intensity = tot > 0 ? clamp(score / tot, 0, 1) : 0;
        const top = Object.entries(item.holidays).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, d]) => `${c} (${d} ημ.)`).join(', ');
        S.push({ key: 'holidays', label: 'Διακοπές χωρών-πελατών', value: clamp(intensity * 2 - 0.4, -0.4, 1), weight: 0.15, real: true, text: `Διακοπές στον μήνα: ${top}` });
    }
    // 4. Πτήσεις (ζωντανά δεδομένα — έχουν νόημα μόνο για κοντινούς μήνες)
    if (ctx.flights.real && near > 0) {
        const f = ctx.flights.intent === 'HIGH' ? 1 : ctx.flights.intent === 'LOW' ? -1 : 0;
        S.push({ key: 'flights', label: 'Πτήσεις HER/CHQ', value: f, weight: 0.15 * near, real: true, text: `Πτήσεις τώρα: ${ctx.flights.total} (${ctx.flights.intent})` });
    }
    // 5. Πληρότητα ανταγωνιστών (Apify — μόνο αν είναι πραγματική & για κοντινούς μήνες)
    const regional = num(item.regionalOccupancyProxy);
    const compOcc = regional !== null ? (regional > 1 ? regional / 100 : regional) : (ctx.competitors.real ? ctx.competitors.occupancy : null);
    if (compOcc !== null && near > 0) {
        S.push({ key: 'competitors', label: 'Πληρότητα ανταγωνιστών', value: compOcc >= 0.85 ? 1 : compOcc >= 0.65 ? 0.4 : compOcc < 0.45 ? -1 : 0, weight: 0.1 * near, real: true,
                 text: `Ανταγωνιστές: ${(compOcc * 100).toFixed(0)}% πληρότητα` });
    }
    return { signals: S, lead, freshness, adr, mAdr, occ, mOcc };
}

function priceFor(item, ctx) {
    const baselinePrice = num(item.baselinePrice), assetScore = num(item.assetScore) || 150;
    const B = buildSignals(item, ctx), S = B.signals.filter(s => s.real && s.weight > 0);
    const wsum = S.reduce((a, s) => a + s.weight, 0);
    // Κατηγορία ακινήτου (όπως πριν): οι κορυφαίες βίλες «αντέχουν» να μη ρίξουν τιμή και πιέζουν ψηλότερα στη ζήτηση
    let dropResistance = 0, pushPower = 0, tierLabel = 'Quality';
    if (assetScore >= 180) { dropResistance = 0.25; pushPower = 0.15; tierLabel = 'Elite Sanctuary'; }
    else if (assetScore >= 160) { dropResistance = 0.12; pushPower = 0.08; tierLabel = 'Premium Retreat'; }
    else if (assetScore < 140) tierLabel = 'Under Review';
    const base = { villaName: item.villaName, month: item.month || 'N/A', baselinePrice, tier: tierLabel };
    if (!baselinePrice) return { ...base, action: 'INVALID', shadowRate: null, explainability: 'Λείπει η τιμή βάσης.' };
    const hasCore = S.some(s => s.key !== 'holidays');      // οι αργίες ΕΝΙΣΧΥΟΥΝ, αλλά δεν αρκούν μόνες τους
    if (wsum < 0.15 || !hasCore) {                           // ΤΙΜΙΟΤΗΤΑ: χωρίς αρκετά πραγματικά δεδομένα, καμία πρόταση
        const why = B.freshness !== null && B.freshness > 60 ? `Τα στοιχεία αγοράς είναι παλιά (${B.freshness} ημερών)· χρειάζεται νέο export KeyData.`
                  : 'Δεν υπάρχουν αρκετά πραγματικά δεδομένα αγοράς για αυτόν τον μήνα (στείλτε market από το KEYDATA_SIGNALS.json).';
        return { ...base, action: 'INSUFFICIENT_DATA', shadowRate: baselinePrice, marketDemand: null, demandScore: null, confidence: 'NONE', drivers: [], dataAgeDays: B.freshness, leadDays: B.lead,
                 explainability: why + ' Κρατήστε την τιμή βάσης.' };
    }
    const signal = S.reduce((a, s) => a + s.weight * s.value, 0) / wsum;          // -1 … +1
    const demandScore = Math.round(50 + 50 * signal);
    let adj = signal * 0.15;                                                      // ζήτηση: έως ±15%
    if (adj > 0) adj += pushPower * signal; else adj *= (1 - dropResistance);
    // Θέση τιμής έναντι αγοράς (ARI): αν γεμίζουμε γρηγορότερα ΚΑΙ είμαστε φθηνότεροι → κλείνουμε μέρος του κενού (και αντίστροφα)
    let gapNote = null;
    if (B.adr && B.mAdr && B.occ && B.mOcc !== null) {
        const ari = B.mAdr / B.adr, mpi = B.mOcc / B.occ;
        if (ari < 0.95 && mpi > 1.1) { const g = clamp((1 - ari) * 0.3, 0, 0.1); adj += g; gapNote = `Είμαστε ${Math.round((1 - ari) * 100)}% φθηνότεροι από την αγορά ενώ γεμίζουμε γρηγορότερα → +${Math.round(g * 100)}%`; }
        else if (ari > 1.05 && mpi < 0.9) { const g = clamp((ari - 1) * 0.3, 0, 0.1) * (1 - dropResistance); adj -= g; gapNote = `Είμαστε ${Math.round((ari - 1) * 100)}% ακριβότεροι από την αγορά ενώ γεμίζουμε πιο αργά → −${Math.round(g * 100)}%`; }
    }
    adj = clamp(adj, -0.25, 0.25);
    const shadowRate = Math.round(baselinePrice * (1 + adj) / 5) * 5;
    const action = adj > 0.02 ? 'YIELD_UP' : adj < -0.02 ? 'YIELD_DOWN' : 'HOLD';
    const confidence = wsum >= 0.6 && (B.freshness === null || B.freshness <= 30) ? 'HIGH' : wsum >= 0.35 ? 'MEDIUM' : 'LOW';
    const drivers = S.sort((a, b) => Math.abs(b.weight * b.value) - Math.abs(a.weight * a.value)).map(s => ({ key: s.key, label: s.label, effect: Math.round(s.value * 100) / 100, weight: Math.round(s.weight * 100) / 100, text: s.text }));
    if (gapNote) drivers.push({ key: 'priceGap', label: 'Θέση τιμής έναντι αγοράς', text: gapNote });
    const out = { ...base, shadowRate, range: { min: Math.round(shadowRate * 0.97 / 5) * 5, max: Math.round(shadowRate * 1.03 / 5) * 5 },
                  marketDemand: demandScore, demandScore, action, confidence, drivers, leadDays: B.lead, dataAgeDays: B.freshness,
                  explainability: `Ζήτηση ${demandScore}/100 · ${action} (${adj >= 0 ? '+' : ''}${Math.round(adj * 100)}%) · Βεβαιότητα ${confidence} · ${drivers.slice(0, 3).map(d => d.text).join(' · ')}` };
    const bp = num(item.beyondPrice);
    if (bp) { const d = shadowRate / bp - 1; out.beyond = { price: bp, deltaPct: Math.round(d * 1000) / 10, verdict: Math.abs(d) <= 0.05 ? 'Συμφωνία με Beyond' : (d > 0 ? 'Πάνω από το Beyond' : 'Κάτω από το Beyond') }; }
    return out;
}

export { priceFor, buildSignals, parseMonth };   // για δοκιμές

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-muses-key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method === 'GET') return res.status(200).json({ engine: 'Muses Master Rates', engineVersion: ENGINE_VERSION, ok: true });   // έλεγχος έκδοσης από browser
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if (MUSES_API_KEY && (req.headers?.['x-muses-key'] || '') !== MUSES_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const body = req.body || {};
        let items = [];
        if (Array.isArray(body.items)) items = body.items;
        else if (body.villaName && body.baselinePrice) items = [{ ...body, assetScore: body.assetScore || 150 }];
        else return res.status(400).json({ error: 'Missing required payload parameters.' });
        const now = Date.now();

        // ── Πτήσεις (AviationStack) & ανταγωνιστές (Apify): ΠΑΡΑΛΛΗΛΑ — ΠΟΤΕ «πλαστά» νούμερα: αν αποτύχει, real=false ──
        const t0 = Date.now();
        const flights = { real: false, her: null, chq: null, total: null, intent: null, source: 'UNAVAILABLE' };
        const competitors = { real: false, occupancy: null, trend: null, sample: 0, source: 'UNAVAILABLE' };
        const fetchFlights = async () => {
        if (globalCache.flights.data && (now - globalCache.flights.timestamp < CACHE_TTL)) Object.assign(flights, globalCache.flights.data, { source: 'CACHED' });
        else if (AVIATION_API_KEY) {
            try {
                const [h, c] = await Promise.all([
                    axios.get(`http://api.aviationstack.com/v1/flights?access_key=${AVIATION_API_KEY}&arr_iata=HER&flight_status=scheduled&limit=100`, { timeout: 8000 }),
                    axios.get(`http://api.aviationstack.com/v1/flights?access_key=${AVIATION_API_KEY}&arr_iata=CHQ&flight_status=scheduled&limit=100`, { timeout: 8000 })]);
                const her = num(h.data?.pagination?.total), chq = num(c.data?.pagination?.total);
                if (her !== null && chq !== null) {
                    const total = her + chq; const data = { real: true, her, chq, total, intent: total > 80 ? 'HIGH' : (total < 30 ? 'LOW' : 'NORMAL') };
                    Object.assign(flights, data, { source: 'LIVE' }); globalCache.flights = { data, timestamp: now };
                }
            } catch (e) { console.error('Aviation API Error:', e.message); }
        } };
        // ── Ανταγωνιστές (Apify) — μόνο πεδία ΠΛΗΡΟΤΗΤΑΣ (όχι τιμές), μόνο έγκυρες τιμές ──
        const fetchCompetitors = async () => {
        if (globalCache.market.data && (now - globalCache.market.timestamp < CACHE_TTL)) Object.assign(competitors, globalCache.market.data, { source: 'CACHED' });
        else if (APIFY_API_TOKEN) {
            try {
                const keys = Object.keys(DATASETS).filter(k => DATASETS[k]);
                const resp = await Promise.all(keys.map(k => axios.get(`https://api.apify.com/v2/datasets/${DATASETS[k]}/items?token=${APIFY_API_TOKEN}&limit=50`, { timeout: 8000 })));
                let occs = [], trends = [];
                resp.forEach((r, i) => (Array.isArray(r.data) ? r.data : []).forEach(it => {
                    if (keys[i] === 'trends') { const t = num(it.value ?? it.score ?? it.interest); if (t !== null) trends.push(t); return; }
                    let o = num(it.occupancyRate ?? it.occupancy); if (o === null) return; if (o > 1) o = o / 100; if (o >= 0 && o <= 1) occs.push(o);
                }));
                if (occs.length >= 5) {
                    const data = { real: true, occupancy: occs.reduce((a, b) => a + b, 0) / occs.length, sample: occs.length, trend: trends.length ? trends.reduce((a, b) => a + b, 0) / trends.length : null };
                    Object.assign(competitors, data, { source: 'LIVE' }); globalCache.market = { data, timestamp: now };
                }
            } catch (e) { console.error('Apify Fetch Error:', e.message); }
        } };
        await Promise.all([fetchFlights(), fetchCompetitors()]);
        const ctx = { flights, competitors };
        const results = items.map(it => priceFor(it, ctx));
        const dataQuality = { flights: flights.source, competitors: competitors.source, keydata: items.some(i => i.market) ? 'PROVIDED' : 'MISSING', holidays: items.some(i => i.holidays) ? 'PROVIDED' : 'MISSING' };

        if (!body.items && results.length === 1) {
            const r = results[0];
            return res.status(200).json({ villa: r.villaName, baseline: r.baselinePrice, demandScore: r.demandScore, action: r.action, shadowRate: r.shadowRate, engineVersion: ENGINE_VERSION,
                                          range: r.range, confidence: r.confidence, drivers: r.drivers, beyond: r.beyond, explainability: r.explainability, dataQuality });
        }
        let aiSummary = null;
        if (body.summary !== false && Date.now() - t0 < 5000) {
            const ups = results.filter(r => r.action === 'YIELD_UP').length, downs = results.filter(r => r.action === 'YIELD_DOWN').length;
            aiSummary = await getResilientAISummary(`Act as chief revenue officer for Muses villas in Crete. In one professional Greek sentence summarize: ${results.length} price checks, ${ups} suggest increase, ${downs} decrease. Data: flights ${flights.source}${flights.real ? ' (' + flights.total + ')' : ''}, KeyData market ${dataQuality.keydata}, holidays ${dataQuality.holidays}. No fluff.`);
        }
        res.status(200).json({ success: true, engineVersion: ENGINE_VERSION, marketIntelligence: { flightsHER: flights.her, flightsCHQ: flights.chq, competitorOccupancy: competitors.occupancy, aiSummary, dataQuality }, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}