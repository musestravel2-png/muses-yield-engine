import { Groq } from 'groq-sdk';
import axios from 'axios';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const AVIATION_API_KEY = process.env.AVIATION_API_KEY;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    
    try {
        const { villaName, baselinePrice, regionalOccupancyProxy } = req.body;
        
        let flightIntentProxy = 'NORMAL';
        let aviationData = 0;
        let flightsHer = 0;
        let flightsChq = 0;

        try {
            const [resHer, resChq] = await Promise.all([
                axios.get(`http://api.aviationstack.com/v1/flights?access_key=${AVIATION_API_KEY}&arr_iata=HER&flight_status=scheduled&limit=100`),
                axios.get(`http://api.aviationstack.com/v1/flights?access_key=${AVIATION_API_KEY}&arr_iata=CHQ&flight_status=scheduled&limit=100`)
            ]);
            
            flightsHer = resHer.data.pagination?.total || 0;
            flightsChq = resChq.data.pagination?.total || 0;
            aviationData = flightsHer + flightsChq;
            
            if (aviationData > 80) flightIntentProxy = 'HIGH';
            else if (aviationData < 30) flightIntentProxy = 'LOW';
        } catch (aErr) {
            console.error('Aviation API Error:', aErr.message);
            flightIntentProxy = 'HIGH'; 
        }
        
        let score = 50; 
        
        if (regionalOccupancyProxy >= 0.80) score += 25;
        else if (regionalOccupancyProxy >= 0.60) score += 10;
        else if (regionalOccupancyProxy < 0.40) score -= 15;

        if (flightIntentProxy === 'HIGH') score += 15;
        else if (flightIntentProxy === 'LOW') score -= 10;
        
        score = Math.max(0, Math.min(100, score));

        let multiplier = 1.0;
        let action = 'HOLD';
        
        if (score >= 75) { action = 'YIELD_UP'; multiplier = 1.15 + ((score - 75) / 25) * 0.20; }
        else if (score >= 60) { action = 'YIELD_UP'; multiplier = 1.05 + ((score - 60) / 15) * 0.09; }
        else if (score <= 45) { action = 'YIELD_DOWN'; multiplier = 0.75 + (score / 45) * 0.24; }

        const shadowRate = Math.round((baselinePrice * multiplier) / 5) * 5;

        const completion = await groq.chat.completions.create({
            messages: [{ 
                role: "user", 
                content: `Act as a revenue manager for premium Cretan villas. Explain this pricing decision in one short Greek sentence: Villa ${villaName}, old price ${baselinePrice}, new price ${shadowRate}. Demand score is ${score}/100. Action: ${action}. Mention live scheduled flights to Crete (HER: ${flightsHer}, CHQ: ${flightsChq}). Keep it professional, factual, no fluff. Do not use words like luxury, unforgettable, escape.` 
            }],
            model: "openai/gpt-oss-20b",
        });

        const explainability = completion.choices[0]?.message?.content || `Score ${score}/100. Flights HER: ${flightsHer}, CHQ: ${flightsChq}. Action: ${action}.`;

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