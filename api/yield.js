import { Groq } from 'groq-sdk';
import axios from 'axios';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const AVIATION_API_KEY = process.env.AVIATION_API_KEY;
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;

let flightCache = null;
let flightCacheTimestamp = 0;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    
    try {
        const { villaName, baselinePrice, regionalOccupancyProxy } = req.body;
        
        let flightsHer = 0;
        let flightsChq = 0;
        let flightIntentProxy = 'NORMAL';
        
        const now = Date.now();
        if (flightCache && (now - flightCacheTimestamp < 3600000)) {
            flightsHer = flightCache.her;
            flightsChq = flightCache.chq;
        } else {
            try {
                const [resHer, resChq] = await Promise.all([
                    axios.get(`http://api.aviationstack.com/v1/flights?access_key=${AVIATION_API_KEY}&arr_iata=HER&flight_status=scheduled&limit=100`),
                    axios.get(`http://api.aviationstack.com/v1/flights?access_key=${AVIATION_API_KEY}&arr_iata=CHQ&flight_status=scheduled&limit=100`)
                ]);
                flightsHer = resHer.data.pagination?.total || 0;
                flightsChq = resChq.data.pagination?.total || 0;
                flightCache = { her: flightsHer, chq: flightsChq };
                flightCacheTimestamp = now;
            } catch (e) {
                if (flightCache) {
                    flightsHer = flightCache.her;
                    flightsChq = flightCache.chq;
                } else {
                    flightsHer = 40; flightsChq = 20; 
                }
            }
        }
        
        const aviationData = flightsHer + flightsChq;
        if (aviationData > 80) flightIntentProxy = 'HIGH';
        else if (aviationData < 30) flightIntentProxy = 'LOW';

        let finalOccupancy = regionalOccupancyProxy;
        try {
            // Δομή Apify. Απαιτείται μελλοντική στόχευση στο ακριβές dataset του Scraper.
            // const apifyRes = await axios.get(`https://api.apify.com/v2/key-value-stores/XXX/records/OUTPUT?token=${APIFY_API_TOKEN}`);
            // finalOccupancy = apifyRes.data.occupancy || regionalOccupancyProxy;
        } catch (e) {
            finalOccupancy = regionalOccupancyProxy;
        }

        let score = 50; 
        if (finalOccupancy >= 0.80) score += 25;
        else if (finalOccupancy >= 0.60) score += 10;
        else if (finalOccupancy < 0.40) score -= 15;

        if (flightIntentProxy === 'HIGH') score += 15;
        else if (flightIntentProxy === 'LOW') score -= 10;
        score = Math.max(0, Math.min(100, score));

        let multiplier = 1.0;
        let action = 'HOLD';
        if (score >= 75) { action = 'YIELD_UP'; multiplier = 1.15 + ((score - 75) / 25) * 0.20; }
        else if (score >= 60) { action = 'YIELD_UP'; multiplier = 1.05 + ((score - 60) / 15) * 0.09; }
        else if (score <= 45) { action = 'YIELD_DOWN'; multiplier = 0.75 + (score / 45) * 0.24; }

        const shadowRate = Math.round((baselinePrice * multiplier) / 5) * 5;

        let explainability = '';
        try {
            const completion = await groq.chat.completions.create({
                messages: [{ 
                    role: "user", 
                    content: `Act as a revenue manager for premium Cretan villas. Explain this pricing decision in one short Greek sentence: Villa ${villaName}, old price ${baselinePrice}, new price ${shadowRate}. Demand score is ${score}/100. Action: ${action}. Mention live scheduled flights to Crete (HER: ${flightsHer}, CHQ: ${flightsChq}). Keep it professional, factual, no fluff. Do not use words like luxury, unforgettable, escape.` 
                }],
                model: "openai/gpt-oss-20b",
            });
            explainability = completion.choices[0]?.message?.content;
        } catch (error) {
            explainability = `Αυτόματη καταχώρηση. Score: ${score}/100, Πτήσεις (HER:${flightsHer}, CHQ:${flightsChq}). Ενέργεια: ${action}.`;
        }

        res.status(200).json({
            villa: villaName,
            baseline: baselinePrice,
            demandScore: score,
            action: action,
            shadowRate: shadowRate,
            explainability: explainability
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}