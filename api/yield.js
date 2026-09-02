import { Groq } from 'groq-sdk';
import axios from 'axios';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const AVIATION_API_KEY = process.env.AVIATION_API_KEY;
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;

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

const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 Ώρες Cache

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    
    try {
        const body = req.body || {};
        
        // Υποστήριξη και των δύο τύπων αιτημάτων (Batch array ή Single item)
        let items = [];
        if (body.items && Array.isArray(body.items)) {
            items = body.items;
        } else if (body.villaName && body.baselinePrice) {
            items = [{ villaName: body.villaName, baselinePrice: body.baselinePrice, month: body.month || 'N/A' }];
        } else {
            return res.status(400).json({ error: 'Missing required payload parameters (villaName or items array).' });
        }

        const now = Date.now();

        // 1. AviationStack (HER & CHQ) με Cache 12h
        let flightsHer = 45;
        let flightsChq = 25;
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
                flightsChq = resHer.data.pagination?.total || 25;
                globalCache.flights = { data: { her: flightsHer, chq: flightsChq }, timestamp: now };
            } catch (e) {
                console.error('Aviation API Error:', e.message);
            }
        }
        const totalFlights = flightsHer + flightsChq;
        const flightIntentProxy = totalFlights > 80 ? 'HIGH' : (totalFlights < 30 ? 'LOW' : 'NORMAL');

        // 2. Apify Multi-Dataset Integration (Airbnb, Booking, VRBO, Trends) με Cache 12h
        let marketOccupancyProxy = 0.75;
        let searchTrendScore = 50;

        if (APIFY_API_TOKEN) {
            if (globalCache.market.data && (now - globalCache.market.timestamp < CACHE_TTL)) {
                marketOccupancyProxy = globalCache.market.data.occupancy;
                searchTrendScore = globalCache.market.data.trend;
            } else {
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
                                if (sourceKey === 'trends') {
                                    trendItems = resp.data;
                                } else {
                                    allCompetitorItems = allCompetitorItems.concat(resp.data);
                                }
                            }
                        });

                        const validCompetitors = allCompetitorItems.filter(i => i.occupancyRate || i.price || i.rate);
                        if (validCompetitors.length > 0) {
                            const avgOcc = validCompetitors.reduce((acc, curr) => acc + (curr.occupancyRate || curr.rate || 0.75), 0) / validCompetitors.length;
                            marketOccupancyProxy = avgOcc > 1 ? avgOcc / 100 : avgOcc;
                        }

                        if (trendItems.length > 0) {
                            const validTrends = trendItems.filter(i => i.value !== undefined || i.score !== undefined || i.interest !== undefined);
                            if (validTrends.length > 0) {
                                const avgTrend = validTrends.reduce((acc, curr) => acc + (curr.value || curr.score || curr.interest || 50), 0) / validTrends.length;
                                searchTrendScore = avgTrend;
                            }
                        }

                        globalCache.market = { 
                            data: { occupancy: marketOccupancyProxy, trend: searchTrendScore }, 
                            timestamp: now 
                        };
                    }
                } catch (e) {
                    console.error('Apify Multi-Dataset Fetch Error:', e.message);
                }
            }
        }

        // 3. Μαζική επεξεργασία όλων των items
        const results = [];

        for (const item of items) {
            const villaName = item.villaName;
            const baselinePrice = item.baselinePrice;
            const regionalOccupancyProxy = item.regionalOccupancyProxy || marketOccupancyProxy;

            let score = 50;
            if (regionalOccupancyProxy >= 0.80) score += 20;
            else if (regionalOccupancyProxy >= 0.60) score += 10;
            else if (regionalOccupancyProxy < 0.40) score -= 15;

            if (flightIntentProxy === 'HIGH') score += 15;
            else if (flightIntentProxy === 'LOW') score -= 10;

            if (searchTrendScore >= 70) score += 15;
            else if (searchTrendScore < 35) score -= 10;
            
            score = Math.max(0, Math.min(100, score));

            let multiplier = 1.0;
            let action = 'HOLD';
            if (score >= 75) { action = 'YIELD_UP'; multiplier = 1.15 + ((score - 75) / 25) * 0.20; }
            else if (score >= 60) { action = 'YIELD_UP'; multiplier = 1.05 + ((score - 60) / 15) * 0.09; }
            else if (score <= 45) { action = 'YIELD_DOWN'; multiplier = 0.75 + (score / 45) * 0.24; }

            const shadowRate = Math.round((baselinePrice * multiplier) / 5) * 5;
            const explainability = `Demand Score: ${score}/100. Market Occ: ${(regionalOccupancyProxy * 100).toFixed(0)}%. Trends: ${searchTrendScore.toFixed(0)}/100. Flights (HER:${flightsHer}, CHQ:${flightsChq}).`;

            results.push({
                villaName: villaName,
                month: item.month || 'N/A',
                baselinePrice: baselinePrice,
                shadowRate: shadowRate,
                demandScore: score,
                action: action,
                explainability: explainability
            });
        }

        // 4. Groq AI Σύνοψη
        let aiSummary = `Market analysis synchronized. Flights (HER:${flightsHer}, CHQ:${flightsChq}), Occ: ${(marketOccupancyProxy*100).toFixed(0)}%.`;
        try {
            const completion = await groq.chat.completions.create({
                messages: [{ 
                    role: "user", 
                    content: `Act as chief revenue officer for Muses villas in Crete. Summarize in one professional Greek sentence the current market state: Total scheduled flights (HER: ${flightsHer}, CHQ: ${flightsChq}), Market occupancy index at ${(marketOccupancyProxy*100).toFixed(0)}%. No fluff, strict business tone.` 
                }],
                model: "openai/gpt-oss-20b",
            });
            aiSummary = completion.choices[0]?.message?.content || aiSummary;
        } catch (err) {}

        // Επιστροφή απάντησης ανάλογα με τον τύπο κλήσης
        if (!body.items && results.length === 1) {
            return res.status(200).json({
                villa: results[0].villaName,
                baseline: results[0].baselinePrice,
                demandScore: results[0].demandScore,
                action: results[0].action,
                shadowRate: results[0].shadowRate,
                explainability: results[0].explainability
            });
        }

        res.status(200).json({
            success: true,
            marketIntelligence: {
                flightsHER: flightsHer,
                flightsCHQ: flightsChq,
                marketOccupancy: marketOccupancyProxy,
                aiSummary: aiSummary
            },
            results: results
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}