import axios from 'axios';
import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const AVIATION_API_KEY = process.env.AVIATION_API_KEY;
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;

const DATASETS = {
    airbnb: process.env.APIFY_AIRBNB_DATASET_ID || '',
    booking: process.env.APIFY_BOOKING_DATASET_ID || '',
    vrbo: process.env.APIFY_VRBO_DATASET_ID || '',
    trends: process.env.APIFY_TRENDS_DATASET_ID || ''
};

let globalCache = {
    flights: { data: null, timestamp: 0 },
    market: { data: null, timestamp: 0 }
};

const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 Hours

async function getResilientAISummary(prompt) {
    if (OLLAMA_API_KEY) {
        try {
            const ollamaRes = await axios.post('https://ollama.com/api/chat', {
                model: 'gpt-oss:120b',
                messages: [{ role: "user", content: prompt }],
                stream: false
            }, {
                headers: { 'Authorization': `Bearer ${OLLAMA_API_KEY}`, 'Content-Type': 'application/json' },
                timeout: 8000
            });
            const content = ollamaRes.data?.message?.content;
            if (content) return content;
        } catch (e) {
            console.error('Ollama Cloud failed, failing over to Groq:', e.message);
        }
    }

    try {
        const completion = await groq.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "openai/gpt-oss-20b",
        });
        const content = completion.choices[0]?.message?.content;
        if (content) return content;
    } catch (e) {
        console.error('Groq fallback failed:', e.message);
    }

    return "Market analysis synchronized via Muses Engine.";
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const body = req.body || {};
        let items = [];
        
        if (body.items && Array.isArray(body.items)) {
            items = body.items;
        } else if (body.villaName && body.baselinePrice) {
            // [FIX]: Προστέθηκε και εδώ το assetScore για μεμονωμένες κλήσεις
            items = [{ 
                villaName: body.villaName, 
                baselinePrice: body.baselinePrice, 
                month: body.month || 'N/A',
                assetScore: body.assetScore || 150 
            }];
        } else {
            return res.status(400).json({ error: 'Missing required payload parameters.' });
        }

        const now = Date.now();

        // ── 1. AviationStack (HER & CHQ) ──
        let flightsHer = 45;
        let flightsChq = 25;
        let flightsDataSource = 'CACHED';

        if (globalCache.flights.data && (now - globalCache.flights.timestamp < CACHE_TTL)) {
            flightsHer = globalCache.flights.data.her;
            flightsChq = globalCache.flights.data.chq;
        } else {
            try {
                const [resHer, resChq] = await Promise.all([
                    axios.get(`http://api.aviationstack.com/v1/flights?access_key=${AVIATION_API_KEY}&arr_iata=HER&flight_status=scheduled&limit=100`),
                    axios.get(`http://api.aviationstack.com/v1/flights?access_key=${AVIATION_API_KEY}&arr_iata=CHQ&flight_status=scheduled&limit=100`)
                ]);
                flightsHer = resHer.data.pagination?.total || 45;
                flightsChq = resChq.data.pagination?.total || 25;
                
                globalCache.flights = { data: { her: flightsHer, chq: flightsChq }, timestamp: now };
                flightsDataSource = 'LIVE';
            } catch (e) {
                console.error('Aviation API Error:', e.message);
                flightsDataSource = 'FALLBACK';
            }
        }

        const totalFlights = flightsHer + flightsChq;
        const flightIntentProxy = totalFlights > 80 ? 'HIGH' : (totalFlights < 30 ? 'LOW' : 'NORMAL');

        // ── 2. Apify Multi-Dataset ──
        let marketOccupancyProxy = 0.75;
        let searchTrendScore = 50;
        let marketDataSource = 'CACHED';

        if (globalCache.market.data && (now - globalCache.market.timestamp < CACHE_TTL)) {
            marketOccupancyProxy = globalCache.market.data.occupancy;
            searchTrendScore = globalCache.market.data.trend;
        } else if (APIFY_API_TOKEN) {
            try {
                const endpoints = [];
                const keys = [];

                for (const [key, id] of Object.entries(DATASETS)) {
                    if (id) {
                        endpoints.push(axios.get(`https://api.apify.com/v2/datasets/${id}/items?token=${APIFY_API_TOKEN}&limit=50`));
                        keys.push(key);
                    }
                }

                if (endpoints.length > 0) {
                    const responses = await Promise.all(endpoints);
                    let allCompetitorItems = [];
                    let trendItems = [];

                    responses.forEach((resp, idx) => {
                        const sourceKey = keys[idx];
                        if (resp.data && Array.isArray(resp.data)) {
                            if (sourceKey === 'trends') trendItems = resp.data;
                            else allCompetitorItems = allCompetitorItems.concat(resp.data);
                        }
                    });

                    const validCompetitors = allCompetitorItems.filter(i => i.occupancyRate || i.price || i.rate || i.occupancy);
                    if (validCompetitors.length > 0) {
                        const avgOcc = validCompetitors.reduce((acc, curr) => acc + (curr.occupancyRate || curr.rate || curr.occupancy || 0.75), 0) / validCompetitors.length;
                        marketOccupancyProxy = avgOcc > 1 ? avgOcc / 100 : avgOcc;
                        marketDataSource = 'LIVE';
                    }

                    const validTrends = trendItems.filter(i => i.value !== undefined || i.score !== undefined || i.interest !== undefined);
                    if (validTrends.length > 0) {
                        searchTrendScore = validTrends.reduce((acc, curr) => acc + (curr.value || curr.score || curr.interest || 50), 0) / validTrends.length;
                    }

                    globalCache.market = { data: { occupancy: marketOccupancyProxy, trend: searchTrendScore }, timestamp: now };
                }
            } catch (e) {
                console.error('Apify Fetch Error:', e.message);
            }
        }

        // ── 3. Υπολογισμός Demand Score & ASSET QUALITY MULTIPLIER ──
        const results = [];
        for (const item of items) {
            const villaName = item.villaName;
            const baselinePrice = item.baselinePrice;
            const regionalOccupancyProxy = item.regionalOccupancyProxy || marketOccupancyProxy;
            const assetScore = item.assetScore || 150; // Η βαθμολογία του ακινήτου!

            let score = 50;
            if (regionalOccupancyProxy >= 0.80) score += 20;
            else if (regionalOccupancyProxy >= 0.60) score += 10;
            else if (regionalOccupancyProxy < 0.40) score -= 15;

            if (flightIntentProxy === 'HIGH') score += 15;
            else if (flightIntentProxy === 'LOW') score -= 10;

            if (searchTrendScore >= 70) score += 15;
            else if (searchTrendScore < 35) score -= 10;

            // BONUS / PENALTY Βάσει Ποιότητας Καταλύματος
            if (assetScore >= 180) score += 10;       // Elite
            else if (assetScore >= 160) score += 5;   // Premium
            else if (assetScore < 130) score -= 5;    // Under Review

            score = Math.max(0, Math.min(100, score));

            // ASSET DROP RESISTANCE: Τα ακριβά δεν "ξεπουλάνε" εύκολα
            let dropResistance = 0;
            let tierLabel = "Quality";
            
            if (assetScore >= 180) { dropResistance = 0.15; tierLabel = "Elite"; }
            else if (assetScore >= 160) { dropResistance = 0.08; tierLabel = "Premium"; }
            else if (assetScore < 140) { tierLabel = "Under Review"; }

            let multiplier = 1.0;
            let action = 'HOLD';
            
            if (score >= 75) { 
                action = 'YIELD_UP'; 
                multiplier = 1.15 + ((score - 75) / 25) * 0.20; 
                // Τα Elite/Premium διεκδικούν μεγαλύτερο premium όταν η αγορά έχει ζήτηση
                if (assetScore >= 160) multiplier += 0.05; 
            }
            else if (score >= 60) { 
                action = 'YIELD_UP'; 
                multiplier = 1.05 + ((score - 60) / 15) * 0.09; 
            }
            else if (score <= 45) { 
                action = 'YIELD_DOWN'; 
                let rawDrop = 0.75 + (score / 45) * 0.24; 
                // Εφαρμογή Αντίστασης: Μειώνουμε το πόσο θα πέσει η τιμή βάσει ποιότητας
                multiplier = rawDrop + ((1 - rawDrop) * dropResistance);
            }

            const shadowRate = Math.round((baselinePrice * multiplier) / 5) * 5;
            const explainability = `Demand: ${score}/100. Occ: ${(regionalOccupancyProxy * 100).toFixed(0)}%. Asset Tier: ${tierLabel} (Score: ${assetScore.toFixed(0)}).`;

            results.push({
                villaName, month: item.month || 'N/A', baselinePrice, shadowRate,
                demandScore: score, action, explainability
            });
        }

        // ── 4. Resilient AI Market Summary ──
        const prompt = `Act as chief revenue officer for Muses villas in Crete. Summarize in one professional Greek sentence the current market state: Total scheduled flights (HER: ${flightsHer}, CHQ: ${flightsChq}), Market occupancy index at ${(marketOccupancyProxy*100).toFixed(0)}%. No fluff, strict business tone.`;
        const aiSummary = await getResilientAISummary(prompt);

        if (!body.items && results.length === 1) {
            return res.status(200).json({
                villa: results[0].villaName, baseline: results[0].baselinePrice,
                demandScore: results[0].demandScore, action: results[0].action,
                shadowRate: results[0].shadowRate, explainability: results[0].explainability,
                dataQuality: { flights: flightsDataSource, market: marketDataSource }
            });
        }

        res.status(200).json({
            success: true,
            marketIntelligence: {
                flightsHER: flightsHer, flightsCHQ: flightsChq,
                marketOccupancy: marketOccupancyProxy, aiSummary,
                dataQuality: { flights: flightsDataSource, market: marketDataSource }
            },
            results
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}