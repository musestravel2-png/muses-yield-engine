import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    
    try {
        const { villaName, baselinePrice, regionalOccupancyProxy, flightIntentProxy } = req.body;
        
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
                content: `Act as a revenue manager for premium Cretan villas. Explain this pricing decision in one short Greek sentence: Villa ${villaName}, old price ${baselinePrice}, new price ${shadowRate}. Demand score is ${score}/100. Local occupancy is ${regionalOccupancyProxy*100}%. Action: ${action}. Keep it professional, factual, no fluff. Do not use words like luxury, unforgettable.` 
            }],
            model: "llama-3.1-70b-versatile",
        });

        const explainability = completion.choices[0]?.message?.content || `Score ${score}/100. Action: ${action}.`;

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