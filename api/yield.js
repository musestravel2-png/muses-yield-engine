import axios from 'axios';
import { Groq } from 'groq-sdk';

// =====================================================================
// MUSES · MASTER RATES ENGINE v3.2 — Αυτόνομος Σύμβουλος Δυναμικής Τιμολόγησης
// v3.2: αργίες ΜΟΝΟ συμπληρωματικά (όχι αύξηση χωρίς αγορά) · ήπια σύγκριση με πέρσι σε μικρά νούμερα ·
//       ίδια προστασία πρώιμης σεζόν για αυξήσεις & μειώσεις · στοιχεία ΑΝΑ ΒΙΛΑ (villaOcc/villaOccLY/villaAdr)
// 100% συμβατός με όλες τις υπάρχουσες κλήσεις (Master Rates Sheet & Muses PMS).
// Υποστηριζόμενα πεδία ανά item:
//   villaName, baselinePrice, month ("2027-07", "07/2027", "07. Ιούλιος", κ.λπ.), assetScore
//   market: { zone, asOf, occ, occLY, adr, adrLY, revpar, revparLY, musesOcc, musesAdr }
//   holidays: { "Γερμανία": 31, ... } (αν λείπει, υπολογίζεται αυτόματα από το ενσωματωμένο ημερολόγιο)
//   sourceMarkets: { "Γερμανία": 0.35, ... } (αν λείπει, χρησιμοποιούνται τα βάρη αγορών Κρήτης)
//   beyondPrice, regionalOccupancyProxy, floorPrice, ceilingPrice, villaOcc, villaOccLY, villaAdr
// =====================================================================

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const AVIATION_API_KEY = process.env.AVIATION_API_KEY;
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
const ENGINE_VERSION = 'v3.2';
const MUSES_API_KEY = process.env.MUSES_API_KEY || '';

const DATASETS = {
    airbnb: process.env.APIFY_AIRBNB_DATASET_ID || '',
    booking: process.env.APIFY_BOOKING_DATASET_ID || '',
    vrbo: process.env.APIFY_VRBO_DATASET_ID || '',
    trends: process.env.APIFY_TRENDS_DATASET_ID || ''
};

let globalCache = { flights: { data: null, timestamp: 0 }, market: { data: null, timestamp: 0 } };
const CACHE_TTL = 12 * 60 * 60 * 1000;
const OLLAMA_MODELS_CASCADE = ['gpt-oss:120b', 'deepseek-v4-flash', 'mistral-large-3:675b'];

// ── Προεπιλεγμένα βάρη αγορών προέλευσης για βίλες στην Κρήτη (όταν δεν παρέχεται sourceMarkets) ──
const DEFAULT_SOURCE_MARKETS = {
    'Γερμανία': 0.28,
    'Ηνωμένο Βασίλειο': 0.24,
    'Γαλλία': 0.12,
    'Ολλανδία': 0.08,
    'Βέλγιο': 0.06,
    'Αυστρία': 0.05,
    'Ελβετία': 0.04,
    'Ισραήλ': 0.04,
    'Πολωνία': 0.03,
    'Νορβηγία': 0.02,
    'Σουηδία': 0.02,
    'Δανία': 0.01,
    'Ρουμανία': 0.01
};

// ── Ενσωματωμένο Ημερολόγιο Σχολικών Διακοπών (Fallback αν το payload δεν στείλει holidays) ──
const BUILTIN_HOLIDAYS = [
    ['Γερμανία', '2025-06-28', '2025-09-07'], ['Γερμανία', '2025-10-06', '2025-11-07'],
    ['Γερμανία', '2026-03-30', '2026-04-11'], ['Γερμανία', '2026-05-26', '2026-06-05'],
    ['Γερμανία', '2026-06-27', '2026-09-06'], ['Γερμανία', '2026-10-05', '2026-11-06'],
    ['Γερμανία', '2027-03-22', '2027-04-03'], ['Γερμανία', '2027-05-18', '2027-05-29'],
    ['Γερμανία', '2027-07-08', '2027-09-13'], ['Γερμανία', '2027-10-04', '2027-11-06'],
    ['Ηνωμένο Βασίλειο', '2025-07-23', '2025-09-01'], ['Ηνωμένο Βασίλειο', '2025-10-20', '2025-10-31'],
    ['Ηνωμένο Βασίλειο', '2026-03-30', '2026-04-10'], ['Ηνωμένο Βασίλειο', '2026-05-25', '2026-05-29'],
    ['Ηνωμένο Βασίλειο', '2026-07-22', '2026-08-31'], ['Ηνωμένο Βασίλειο', '2026-10-26', '2026-10-30'],
    ['Ηνωμένο Βασίλειο', '2027-03-26', '2027-04-09'], ['Ηνωμένο Βασίλειο', '2027-05-31', '2027-06-04'],
    ['Ηνωμένο Βασίλειο', '2027-07-22', '2027-08-31'], ['Ηνωμένο Βασίλειο', '2027-10-25', '2027-10-29'],
    ['Γαλλία', '2025-07-05', '2025-09-01'], ['Γαλλία', '2025-10-18', '2025-11-03'],
    ['Γαλλία', '2026-04-04', '2026-05-03'], ['Γαλλία', '2026-07-04', '2026-09-01'], ['Γαλλία', '2026-10-17', '2026-11-02'],
    ['Γαλλία', '2027-04-03', '2027-05-02'], ['Γαλλία', '2027-07-03', '2027-09-02'], ['Γαλλία', '2027-10-23', '2027-11-08'],
    ['Ολλανδία', '2025-07-05', '2025-08-31'], ['Ολλανδία', '2025-10-11', '2025-10-26'],
    ['Ολλανδία', '2026-04-25', '2026-05-03'], ['Ολλανδία', '2026-07-04', '2026-08-30'], ['Ολλανδία', '2026-10-10', '2026-10-25'],
    ['Ολλανδία', '2027-04-24', '2027-05-02'], ['Ολλανδία', '2027-07-17', '2027-08-29'], ['Ολλανδία', '2027-10-16', '2027-10-24'],
    ['Βέλγιο', '2025-07-01', '2025-08-31'], ['Βέλγιο', '2025-10-20', '2025-11-02'],
    ['Βέλγιο', '2026-04-06', '2026-05-10'], ['Βέλγιο', '2026-07-01', '2026-08-31'], ['Βέλγιο', '2026-10-19', '2026-11-06'],
    ['Βέλγιο', '2027-03-29', '2027-05-09'], ['Βέλγιο', '2027-07-01', '2027-08-31'], ['Βέλγιο', '2027-11-01', '2027-11-07'],
    ['Αυστρία', '2025-07-05', '2025-09-07'], ['Αυστρία', '2025-10-27', '2025-11-02'],
    ['Αυστρία', '2026-03-28', '2026-04-06'], ['Αυστρία', '2026-05-23', '2026-05-25'],
    ['Αυστρία', '2026-07-04', '2026-09-06'], ['Αυστρία', '2026-10-27', '2026-10-31'],
    ['Αυστρία', '2027-05-15', '2027-05-17'], ['Αυστρία', '2027-07-03', '2027-08-31'], ['Αυστρία', '2027-10-27', '2027-10-31'],
    ['Ισραήλ', '2025-10-06', '2025-10-14'], ['Ισραήλ', '2026-04-01', '2026-04-09'],
    ['Ισραήλ', '2026-05-21', '2026-05-23'], ['Ισραήλ', '2026-09-25', '2026-10-04'],
    ['Ισραήλ', '2027-04-21', '2027-04-29'], ['Ισραήλ', '2027-06-10', '2027-06-12'], ['Ισραήλ', '2027-10-15', '2027-10-23'],
    ['Πολωνία', '2025-06-28', '2025-08-31'], ['Πολωνία', '2026-04-02', '2026-04-07'],
    ['Πολωνία', '2026-06-27', '2026-08-31'], ['Πολωνία', '2027-06-26', '2027-08-31'],
    ['Νορβηγία', '2025-09-29', '2025-10-10'], ['Νορβηγία', '2026-03-28', '2026-04-06'],
    ['Νορβηγία', '2026-06-20', '2026-08-16'], ['Νορβηγία', '2026-09-28', '2026-10-09'],
    ['Νορβηγία', '2027-06-19', '2027-08-15'], ['Νορβηγία', '2027-10-04', '2027-10-15'],
    ['Σουηδία', '2025-10-27', '2025-11-02'], ['Σουηδία', '2026-06-13', '2026-08-16'],
    ['Σουηδία', '2026-10-26', '2026-11-01'], ['Σουηδία', '2027-06-11', '2027-08-15'], ['Σουηδία', '2027-10-25', '2027-10-31'],
    ['Δανία', '2025-10-13', '2025-10-19'], ['Δανία', '2026-06-27', '2026-08-09'],
    ['Δανία', '2026-10-12', '2026-10-18'], ['Δανία', '2027-06-26', '2027-08-08'], ['Δανία', '2027-10-11', '2027-10-17'],
    ['Ρουμανία', '2025-06-14', '2025-09-07'], ['Ρουμανία', '2025-10-25', '2025-11-02'],
    ['Ρουμανία', '2026-04-04', '2026-04-14'], ['Ρουμανία', '2026-06-20', '2026-09-06'], ['Ρουμανία', '2026-10-24', '2026-11-01'],
    ['Ρουμανία', '2027-04-30', '2027-05-09'], ['Ρουμανία', '2027-06-19', '2027-09-05'], ['Ρουμανία', '2027-10-23', '2027-10-31']
];

function getBuiltinHolidaysForMonth(pm) {
    if (!pm || !pm.y || !pm.m) return null;
    const mStart = new Date(Date.UTC(pm.y, pm.m - 1, 1));
    const mEnd = new Date(Date.UTC(pm.y, pm.m, 0));
    const counts = {};
    for (const [country, sStr, eStr] of BUILTIN_HOLIDAYS) {
        const s = new Date(sStr + 'T00:00:00Z'), e = new Date(eStr + 'T00:00:00Z');
        if (e < mStart || s > mEnd) continue;
        const start = s > mStart ? s : mStart;
        const end = e < mEnd ? e : mEnd;
        const days = Math.round((end - start) / 86400000) + 1;
        if (days > 0) counts[country] = Math.min(31, (counts[country] || 0) + days);
    }
    return Object.keys(counts).length ? counts : null;
}

// ── Ταχύτατη Σύνοψη AI με Αυστηρό Προϋπολογισμό Χρόνου (ποτέ δεν προκαλεί Vercel Timeout) ──
async function getResilientAISummary(prompt, maxBudgetMs = 2800) {
    const start = Date.now();
    if (OLLAMA_API_KEY) {
        for (const model of OLLAMA_MODELS_CASCADE) {
            const rem = maxBudgetMs - (Date.now() - start);
            if (rem < 900) break;
            try {
                const r = await axios.post(
                    'https://ollama.com/api/chat',
                    { model, messages: [{ role: 'user', content: prompt }], stream: false },
                    { headers: { Authorization: `Bearer ${OLLAMA_API_KEY}`, 'Content-Type': 'application/json' }, timeout: Math.min(2000, rem) }
                );
                const content = r.data?.message?.content;
                if (content) return content.trim();
            } catch (e) {
                console.error(`Ollama model ${model} skipped:`, e.message);
            }
        }
    }
    if (process.env.GROQ_API_KEY && (Date.now() - start) < maxBudgetMs) {
        try {
            const c = await Promise.race([
                groq.chat.completions.create({ messages: [{ role: 'user', content: prompt }], model: 'openai/gpt-oss-20b' }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('Groq timeout')), Math.max(800, maxBudgetMs - (Date.now() - start))))
            ]);
            const content = c?.choices?.[0]?.message?.content;
            if (content) return content.trim();
        } catch (e) {
            console.error('Groq fallback skipped:', e.message);
        }
    }
    return null;
}

// ── Βοηθητικές Συναρτήσεις ──
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);

function parseMonth(m) {
    if (m === null || m === undefined) return null;
    const raw = String(m).trim();
    if (!raw) return null;
    // 1. "2027-07" ή "2027/07"
    let r = raw.match(/^(\d{4})[\/.-](\d{1,2})$/);
    if (r) return { y: +r[1], m: clamp(+r[2], 1, 12) };
    // 2. "07/2027" ή "7-2027"
    r = raw.match(/^(\d{1,2})[\/.-](\d{4})$/);
    if (r) return { y: +r[2], m: clamp(+r[1], 1, 12) };
    // 3. Ελληνικά ή Αγγλικά ονόματα μηνών (π.χ. "07. Ιούλιος 2027", "Ιούλιος", "Jul 2026")
    const norm = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const gr = ['ιαν', 'φεβ', 'μαρ', 'απρ', 'μαι', 'ιουν', 'ιουλ', 'αυγ', 'σεπ', 'οκτ', 'νοε', 'δεκ'];
    const en = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    let foundM = null;
    for (let i = 0; i < 12; i++) {
        if (norm.includes(gr[i]) || norm.includes(en[i])) { foundM = i + 1; break; }
    }
    if (!foundM) {
        const leadingNum = raw.match(/^(\d{1,2})\b/);
        if (leadingNum && +leadingNum[1] >= 1 && +leadingNum[1] <= 12) foundM = +leadingNum[1];
    }
    if (foundM) {
        const yrMatch = raw.match(/\b(20\d{2})\b/);
        const now = new Date();
        const defaultYr = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
        return { y: yrMatch ? +yrMatch[1] : defaultYr, m: foundM };
    }
    return null;
}

function leadDays(pm) {
    if (!pm) return null;
    const mid = new Date(pm.y, pm.m - 1, 15);
    return Math.round((mid - new Date()) / 86400000);
}

function getSeasonConfig(m) {
    if (m === 7 || m === 8) return { key: 'PEAK', label: 'Peak (Ιούλ–Αύγ)', baseMinStay: 7 };
    if (m === 6 || m === 9) return { key: 'HIGH', label: 'High (Ιούν/Σεπ)', baseMinStay: 5 };
    if (m === 5 || m === 10) return { key: 'SHOULDER', label: 'Shoulder (Μάι/Οκτ)', baseMinStay: 5 };
    return { key: 'LOW', label: 'Low Season', baseMinStay: 4 };
}

// ── Κατασκευή Σημάτων (v3.0-PRO) ──
function buildSignals(item, ctx = { flights: {}, competitors: {} }) {
    const S = [];
    const pm = parseMonth(item.month);
    const lead = leadDays(pm);
    // Πτήσεις & ανταγωνιστές Apify έχουν βαρύτητα μόνο κοντά στην ημερομηνία άφιξης (-10 έως +45 ημέρες)
    const near = lead === null ? 0.35 : (lead >= -10 && lead <= 30 ? 1 : (lead > 30 && lead <= 50 ? 0.45 : 0));

    const mk = item.market || {};
    const occ = num(mk.occ), occLY = num(mk.occLY);
    const adr = num(mk.adr), adrLY = num(mk.adrLY);
    const revpar = num(mk.revpar) ?? (occ !== null && adr !== null ? (occ / 100) * adr : null);
    const revparLY = num(mk.revparLY) ?? (occLY !== null && adrLY !== null ? (occLY / 100) * adrLY : null);

    // Υποστήριξη τόσο ζώνης Muses (musesOcc/musesAdr) όσο και μεμονωμένης βίλας (villaOcc/villaAdr) αν περαστεί
    const hasVilla = num(item.villaOcc) !== null;
    const mOcc = hasVilla ? num(item.villaOcc) : num(mk.musesOcc);
    const mOccLY = num(item.villaOccLY);
    const mAdr = num(item.villaAdr);   // ADR κρατήσεων της ΒΙΛΑΣ (όχι της ζώνης Muses)· αλλιώς συγκρίνεται η τιμή βάσης

    let freshness = null;
    if (mk.asOf) {
        const d = new Date(mk.asOf);
        if (!isNaN(d)) freshness = Math.max(0, Math.round((new Date() - d) / 86400000));
    }
    const fresh = freshness === null ? 1 : (freshness <= 30 ? 1 : freshness <= 60 ? 0.65 : 0.35);

    // 1. Ρυθμός Πληρότητας Αγοράς έναντι Πέρσι (KeyData Market Occupancy Pace)
    // Αξιοπιστία σύγκρισης: με λίγες κλεισμένες νύχτες (π.χ. 7% πέρσι) το «+190%» είναι θόρυβος → μικρότερο βάρος
    const rel = (occLY === null) ? 0.35 : clamp(occLY / 15, 0.35, 1);
    if (occ !== null && occLY !== null && occLY >= 1) {
        const pace = occ / occLY - 1;
        const paceSafe = (occ - occLY) / Math.max(occLY, 10);   // διαφορά μονάδων επί τουλάχιστον 10% βάσης
        S.push({
            key: 'marketPace',
            label: 'Ρυθμός αγοράς έναντι πέρσι',
            value: clamp(paceSafe / 0.6, -1, 1),
            weight: 0.30 * fresh * rel,
            real: true,
            text: `Η αγορά${mk.zone ? ' (' + mk.zone + ')' : ''} έχει κλείσει ${occ.toFixed(1)}% έναντι ${occLY.toFixed(1)}% πέρσι (${pace >= 0 ? '+' : ''}${Math.round(pace * 100)}%)`
        });
    }

    // 2. Δυναμική Τιμών & RevPAR Αγοράς έναντι Πέρσι (Αξιοποίηση adrLY & revparLY από το KEYDATA_SIGNALS.json)
    if (adr !== null && adrLY !== null && adrLY > 20) {
        const adrPace = adr / adrLY - 1;
        const occDropping = (occ !== null && occLY !== null && occLY >= 2 && (occ / occLY - 1) < -0.10);
        // Αν η αγορά ανέβασε τιμές (>+8%) αλλά χάνει πληρότητα (<-10%), η αγορά συναντά αντίσταση τιμής
        const effVal = (adrPace > 0.08 && occDropping)
            ? -clamp(adrPace / 0.25, 0.1, 0.7)
            : clamp(adrPace / 0.22, -1, 1);
        const revParTxt = (revpar !== null && revparLY !== null && revparLY > 5)
            ? `, RevPAR ${revpar >= revparLY ? '+' : ''}${Math.round((revpar / revparLY - 1) * 100)}%`
            : '';
        S.push({
            key: 'marketAdrPace',
            label: 'Τάση τιμών αγοράς (ADR)',
            value: effVal,
            weight: 0.12 * fresh * rel,
            real: true,
            text: `Μέση τιμή αγοράς €${Math.round(adr)} έναντι €${Math.round(adrLY)} πέρσι (${adrPace >= 0 ? '+' : ''}${Math.round(adrPace * 100)}%${revParTxt})${adrPace > 0.08 && occDropping ? ' [αντίσταση τιμής στην αγορά]' : ''}`
        });
    }

    // 3. Ρυθμός Muses / Βίλας έναντι Αγοράς (MPI - Market Penetration Index)
    if (occ !== null && occ >= 1 && mOcc !== null) {
        const mpi = mOcc / occ;
        S.push({
            key: 'ourPace',
            label: hasVilla ? 'Ρυθμός βίλας έναντι αγοράς (MPI)' : 'Ρυθμός Muses (ζώνη) έναντι αγοράς (MPI)',
            value: clamp((mpi - 1) / 0.45, -1, 1),
            weight: (hasVilla ? 0.24 : 0.14) * fresh * rel,
            real: true,
            text: `${hasVilla ? 'Η βίλα γεμίζει' : 'Οι βίλες Muses της ζώνης γεμίζουν'} ${mpi >= 1 ? mpi.toFixed(1) + '× γρηγορότερα' : (1 / Math.max(mpi, 0.05)).toFixed(1) + '× πιο αργά'} από την αγορά (${mOcc.toFixed(1)}% έναντι ${occ.toFixed(1)}%)`
        });
    }

    // 4. Ίδιος Ρυθμός Βίλας έναντι Πέρσι (αν δοθεί villaOcc & villaOccLY)
    if (mOcc !== null && mOccLY !== null && mOccLY >= 3) {
        const vPace = mOcc / mOccLY - 1;
        S.push({
            key: 'villaPace',
            label: 'Ρυθμός βίλας έναντι πέρσι',
            value: clamp(vPace / 0.40, -1, 1),
            weight: 0.16,
            real: true,
            text: `Πληρότητα βίλας ${mOcc.toFixed(1)}% έναντι ${mOccLY.toFixed(1)}% πέρσι (${vPace >= 0 ? '+' : ''}${Math.round(vPace * 100)}%)`
        });
    }

    // 5. Αργίες & Σχολικές Διακοπές Χωρών-Πελατών (από το payload ή αυτόματα από το ενσωματωμένο ημερολόγιο)
    const rawHolidays = (item.holidays && typeof item.holidays === 'object' && Object.keys(item.holidays).length)
        ? item.holidays
        : getBuiltinHolidaysForMonth(pm);

    if (rawHolidays) {
        const activeEntries = Object.entries(rawHolidays).filter(([, days]) => (num(days) || 0) > 0);
        if (activeEntries.length) {
            const hasCustomWeights = item.sourceMarkets && typeof item.sourceMarkets === 'object' && Object.keys(item.sourceMarkets).length > 0;
            const weightsMap = hasCustomWeights ? item.sourceMarkets : DEFAULT_SOURCE_MARKETS;
            let weightedDaysScore = 0, activeShareSum = 0;

            const dim = pm ? new Date(Date.UTC(pm.y, pm.m, 0)).getUTCDate() : 31;
            activeEntries.forEach(e => { e[1] = Math.min(dim, num(e[1]) || 0); });   // ποτέ πάνω από τις ημέρες του μήνα
            activeEntries.forEach(([country, days]) => {
                const share = num(weightsMap[country]) ?? 0.03;
                weightedDaysScore += share * clamp((num(days) || 0) / 22, 0, 1);
                activeShareSum += share;
            });

            // Συνδυασμός διάρκειας διακοπών και συνολικού μεριδίου των χωρών που έχουν διακοπές
            const marketCoverage = clamp(activeShareSum / 0.55, 0.25, 1.0);
            const intensity = activeShareSum > 0 ? clamp((weightedDaysScore / activeShareSum) * marketCoverage, 0.05, 1.0) : 0;
            const top = activeEntries
                .sort((a, b) => ((num(weightsMap[b[0]]) || 0.03) * b[1]) - ((num(weightsMap[a[0]]) || 0.03) * a[1]))
                .slice(0, 3)
                .map(([c, d]) => `${c} (${d} ημ.)`)
                .join(', ');

            S.push({
                key: 'holidays',
                label: 'Διακοπές χωρών-πελατών',
                value: clamp(intensity, 0.05, 1),
                weight: 0.06,   // η εποχικότητα υπάρχει ήδη στην τιμή βάσης → μόνο μικρή συμπληρωματική ώθηση
                real: true,
                text: `Διακοπές στον μήνα: ${top}`
            });
        }
    }

    // 6. Πτήσεις Ηρακλείου & Χανίων (AviationStack — ενεργό για κοντινούς μήνες)
    if (ctx.flights?.real && near > 0) {
        const f = ctx.flights.intent === 'HIGH' ? 1 : ctx.flights.intent === 'LOW' ? -0.8 : 0.1;
        S.push({
            key: 'flights',
            label: 'Πτήσεις HER/CHQ',
            value: f,
            weight: 0.10 * near,
            real: true,
            text: `Πτήσεις περιόδου: ${ctx.flights.total} (${ctx.flights.intent})`
        });
    }

    // 7. Πληρότητα & Τάση Αναζητήσεων Ανταγωνιστών (Apify Occupancy + Google Trends)
    const regional = num(item.regionalOccupancyProxy);
    const compOcc = regional !== null ? (regional > 1 ? regional / 100 : regional) : (ctx.competitors?.real ? ctx.competitors.occupancy : null);
    if (compOcc !== null && near > 0) {
        const trendVal = num(ctx.competitors?.trend);
        const trendBoost = trendVal !== null ? clamp((trendVal - 50) / 100, -0.25, 0.25) : 0;
        const baseCompVal = compOcc >= 0.85 ? 1 : compOcc >= 0.65 ? 0.45 : compOcc < 0.45 ? -0.9 : 0;
        S.push({
            key: 'competitors',
            label: 'Πληρότητα ανταγωνιστών',
            value: clamp(baseCompVal + trendBoost, -1, 1),
            weight: 0.10 * near,
            real: true,
            text: `Ανταγωνιστές: ${(compOcc * 100).toFixed(0)}% πληρότητα${trendVal !== null ? ` · Trends ${Math.round(trendVal)}/100` : ''}`
        });
    }

    return { signals: S, pm, lead, freshness, adr, adrLY, revpar, revparLY, mAdr, occ, occLY, mOcc };
}

// ── Κεντρικός Αλγόριθμος Τιμολόγησης (v3.0-PRO) ──
function priceFor(item, ctx = { flights: {}, competitors: {} }) {
    const baselinePrice = num(item.baselinePrice);
    const floorPrice = num(item.floorPrice ?? item.minPrice);
    const ceilingPrice = num(item.ceilingPrice ?? item.maxPrice);
    const assetScore = num(item.assetScore) || 150;

    const B = buildSignals(item, ctx);
    const S = B.signals.filter(s => s.real && s.weight > 0);
    const wsum = S.reduce((a, s) => a + s.weight, 0);

    // Κατηγοριοποίηση ακινήτου (Asset Tiering)
    let dropResistance = 0, pushPower = 0, tierLabel = 'Quality';
    if (assetScore >= 180) { dropResistance = 0.28; pushPower = 0.12; tierLabel = 'Elite Sanctuary'; }
    else if (assetScore >= 160) { dropResistance = 0.14; pushPower = 0.06; tierLabel = 'Premium Retreat'; }
    else if (assetScore < 140) { dropResistance = 0; pushPower = 0; tierLabel = 'Under Review'; }
    else { dropResistance = 0.05; pushPower = 0.02; }

    const season = getSeasonConfig(B.pm ? B.pm.m : 7);
    const base = {
        villaName: item.villaName,
        month: item.month || 'N/A',
        baselinePrice,
        tier: tierLabel,
        seasonalityTier: season.key
    };

    if (!baselinePrice || baselinePrice <= 0) {
        return { ...base, action: 'INVALID', shadowRate: null, explainability: '⚠️ Λείπει η τιμή βάσης.' };
    }

    // Έλεγχος αν ο μήνας έχει ήδη παρέλθει
    if (B.lead !== null && B.lead < -15) {
        return {
            ...base,
            action: 'HOLD',
            shadowRate: baselinePrice,
            range: { min: baselinePrice, max: baselinePrice },
            marketDemand: null,
            demandScore: null,
            confidence: 'NONE',
            drivers: [],
            leadDays: B.lead,
            dataAgeDays: B.freshness,
            recommendedMinStay: season.baseMinStay,
            explainability: 'Ο μήνας έχει ήδη παρέλθει. Διατήρηση τιμής αναφοράς.'
        };
    }

    // Κανόνας Ειλικρίνειας: χωρίς στοιχεία αγοράς/πληρότητας (μόνο αργίες) → ΤΙΜΗ ΒΑΣΗΣ (HOLD), ποτέ αύξηση από αργίες μόνο
    const hasCore = S.some(s => s.key !== 'holidays');
    if (wsum < 0.10 || !hasCore) {
        return {
            ...base,
            action: 'HOLD',
            shadowRate: baselinePrice,
            range: { min: Math.round((baselinePrice * 0.97) / 5) * 5, max: Math.round((baselinePrice * 1.03) / 5) * 5 },
            marketDemand: 50,
            demandScore: 50,
            confidence: 'LOW',
            dataGap: true,
            drivers: [],
            dataAgeDays: B.freshness,
            leadDays: B.lead,
            recommendedMinStay: season.baseMinStay,
            explainability: hasCore ? 'Πολύ λίγα στοιχεία αγοράς για τον μήνα · Διατήρηση τιμής βάσης (HOLD).' : 'Δεν υπάρχουν ακόμη στοιχεία αγοράς (KeyData) για τον μήνα · Διατήρηση τιμής βάσης (HOLD).'
        };
    }

    // ── Καμπύλη Χρόνου Κράτησης (Lead-Time S-Curve) ──
    // Σε >180 ημέρες πριν την άφιξη, προστατεύουμε την τιμή από πρόωρες μειώσεις (Early-Bird Shield)
    const earlyBirdShield = B.lead === null ? 1.0 : (B.lead > 180 ? 0.35 : (B.lead > 120 ? 0.65 : 1.0));
    const rawSignal = S.reduce((a, s) => a + s.weight * s.value, 0) / wsum; // -1 … +1
    const earlyUpShield = B.lead === null ? 1.0 : (B.lead > 180 ? 0.7 : (B.lead > 120 ? 0.85 : 1.0));   // νωρίς: και οι αυξήσεις πιο ήπιες
    const effectiveSignal = rawSignal >= 0 ? rawSignal * earlyUpShield : rawSignal * earlyBirdShield;
    const demandScore = clamp(Math.round(50 + 50 * effectiveSignal), 1, 99);

    let adj = effectiveSignal * 0.15;
    if (adj > 0) adj += pushPower * effectiveSignal;
    else adj *= (1 - dropResistance);

    // ── Πίνακας 4 Τεταρτημορίων Τιμής × Όγκου (ARI × MPI = RGI) ──
    // ΔΙΟΡΘΩΣΗ: Αν το mAdr είναι 0/null (π.χ. 0 κρατήσεις), συγκρίνουμε το baselinePrice με το ADR της αγοράς!
    const effectiveOurAdr = (B.mAdr !== null && B.mAdr > 0) ? B.mAdr : baselinePrice;   // ADR βίλας αν έχει κρατήσεις, αλλιώς η τιμή βάσης
    let gapNote = null, quadrant = 'BALANCED', ari = null, mpi = null, rgi = null;

    if (B.adr !== null && B.adr > 0 && effectiveOurAdr > 0 && B.occ !== null && B.occ >= 1 && B.mOcc !== null) {
        ari = Math.round((effectiveOurAdr / B.adr) * 100) / 100;
        mpi = Math.round((B.mOcc / B.occ) * 100) / 100;
        rgi = Math.round(ari * mpi * 100) / 100;

        if (ari < 0.95 && mpi > 1.10) {
            quadrant = 'UNDERPRICED';
            const g = clamp((1 - ari) * 0.35, 0.02, 0.10);
            adj += g;
            gapNote = `Είμαστε ${Math.round((1 - ari) * 100)}% φθηνότεροι από την αγορά ενώ γεμίζουμε ταχύτερα (RGI ${rgi.toFixed(2)}x) → +${Math.round(g * 100)}%`;
        } else if (ari >= 1.05 && mpi >= 1.05) {
            quadrant = 'PREMIUM_POWER';
            const g = clamp((mpi - 1) * 0.15, 0.02, 0.06);
            adj += g;
            gapNote = `Υπεραπόδοση: υψηλότερη τιμή (+${Math.round((ari - 1) * 100)}%) ΚΑΙ υψηλότερη πληρότητα από την αγορά (RGI ${rgi.toFixed(2)}x) → +${Math.round(g * 100)}%`;
        } else if (ari > 1.05 && mpi < 0.88) {
            quadrant = 'PRICE_RESISTANCE';
            const g = clamp((ari - 1) * 0.35, 0.02, 0.12) * (1 - dropResistance) * earlyBirdShield;
            adj -= g;
            gapNote = `Αντίσταση τιμής: +${Math.round((ari - 1) * 100)}% ακριβότεροι από την αγορά με χαμηλότερη πληρότητα (${B.mOcc.toFixed(0)}% vs ${B.occ.toFixed(0)}%) → −${Math.round(g * 100)}%`;
        } else if (ari <= 0.95 && mpi < 0.85) {
            quadrant = 'DEMAND_DEFICIT';
            gapNote = `Χαμηλή απορρόφηση παρότι είμαστε ήδη ${Math.round((1 - ari) * 100)}% φθηνότεροι από την αγορά → ελέγξτε Min Stay & προβολή αντί για μεγάλη μείωση τιμής`;
        }
    }

    // ── Προσαρμογή Παραθύρου Τελευταίας Στιγμής / Συμπίεσης (0 έως 45 ημέρες πριν την άφιξη) ──
    if (B.lead !== null && B.lead >= 0 && B.lead <= 45 && B.mOcc !== null) {
        if (B.mOcc >= 78 && adj >= 0) {
            const scarcityBoost = 0.04;
            adj += scarcityBoost;
            gapNote = (gapNote ? gapNote + ' · ' : '') + `Υψηλή πληρότητα (${B.mOcc.toFixed(0)}%) στις τελευταίες ${B.lead} ημ. → +4% Scarcity Premium`;
        } else if (B.mOcc < 40 && B.lead <= 30 && quadrant !== 'DEMAND_DEFICIT') {
            const lastMinCut = 0.06 * (1 - dropResistance);
            adj -= lastMinCut;
            gapNote = (gapNote ? gapNote + ' · ' : '') + `Παράθυρο Last-Minute (${B.lead} ημ.) με χαμηλή πληρότητα (${B.mOcc.toFixed(0)}%) → −${Math.round(lastMinCut * 100)}%`;
        }
    }

    adj = clamp(adj, -0.25, 0.25);
    let shadowRate = Math.round((baselinePrice * (1 + adj)) / 5) * 5;

    // ── Εφαρμογή Ορίων Ασφαλείας Ιδιοκτήτη (Floor & Ceiling Price) ──
    if (floorPrice !== null && floorPrice > 0 && shadowRate < floorPrice) {
        shadowRate = Math.round(floorPrice / 5) * 5;
        adj = (shadowRate / baselinePrice) - 1;
        gapNote = (gapNote ? gapNote + ' · ' : '') + `Εφαρμόστηκε κατώτατο όριο τιμής ιδιοκτήτη (€${shadowRate})`;
    }
    if (ceilingPrice !== null && ceilingPrice > 0 && shadowRate > ceilingPrice) {
        shadowRate = Math.round(ceilingPrice / 5) * 5;
        adj = (shadowRate / baselinePrice) - 1;
    }

    // ── Δυναμική Πρόταση Ελάχιστης Διαμονής (Min Stay) ──
    let recommendedMinStay = season.baseMinStay;
    if (B.lead !== null && B.lead <= 30 && B.mOcc !== null && B.mOcc < 55) {
        recommendedMinStay = Math.max(3, season.baseMinStay - 2);
    } else if (B.lead !== null && B.lead <= 45 && quadrant === 'DEMAND_DEFICIT') {
        recommendedMinStay = Math.max(4, season.baseMinStay - 1);
    }

    const action = adj > 0.02 ? 'YIELD_UP' : adj < -0.02 ? 'YIELD_DOWN' : 'HOLD';
    const confidence = wsum >= 0.58 && (B.freshness === null || B.freshness <= 30) ? 'HIGH' : wsum >= 0.32 ? 'MEDIUM' : 'LOW';

    const drivers = S
        .sort((a, b) => Math.abs(b.weight * b.value) - Math.abs(a.weight * a.value))
        .map(s => ({
            key: s.key,
            label: s.label,
            effect: Math.round(s.value * 100) / 100,
            weight: Math.round(s.weight * 100) / 100,
            text: s.text
        }));

    if (gapNote) drivers.push({ key: 'priceGap', label: 'Θέση τιμής & ρυθμού (RGI)', text: gapNote });
    if (B.lead !== null && B.lead > 180 && rawSignal < -0.05) {
        drivers.push({ key: 'earlyShield', label: 'Προστασία Πρώιμης Σεζόν', text: `Ασπίδα πρώιμων κρατήσεων (${B.lead} ημ. πριν): αποτροπή πρόωρης έκπτωσης` });
    }

    const minStayHint = recommendedMinStay !== season.baseMinStay
        ? ` · Προτεινόμενη ελάχ. διαμονή: ${recommendedMinStay}Ν (από ${season.baseMinStay}Ν)`
        : ` · Ελάχ. διαμονή: ${recommendedMinStay}Ν`;

    const out = {
        ...base,
        shadowRate,
        range: {
            min: Math.round((shadowRate * 0.97) / 5) * 5,
            max: Math.round((shadowRate * 1.03) / 5) * 5
        },
        marketDemand: demandScore,
        demandScore,
        action,
        confidence,
        quadrant,
        metrics: { ari, mpi, rgi, marketRevPar: B.revpar ? Math.round(B.revpar) : null },
        recommendedMinStay,
        drivers,
        leadDays: B.lead,
        dataAgeDays: B.freshness,
        explainability: `Ζήτηση ${demandScore}/100 · ${action} (${adj >= 0 ? '+' : ''}${Math.round(adj * 100)}%) · Βεβαιότητα ${confidence}${minStayHint} · ${drivers.slice(0, 3).map(d => d.text).join(' · ')}`
    };

    const bp = num(item.beyondPrice);
    if (bp && bp > 0) {
        const d = shadowRate / bp - 1;
        out.beyond = {
            price: bp,
            deltaPct: Math.round(d * 1000) / 10,
            verdict: Math.abs(d) <= 0.05 ? 'Συμφωνία με Beyond' : (d > 0 ? 'Πάνω από το Beyond' : 'Κάτω από το Beyond')
        };
    }
    return out;
}

export { priceFor, buildSignals, parseMonth, getBuiltinHolidaysForMonth };

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-muses-key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method === 'GET') {
        return res.status(200).json({ engine: 'Muses Master Rates', engineVersion: ENGINE_VERSION, ok: true });
    }
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if (MUSES_API_KEY && (req.headers?.['x-muses-key'] || '') !== MUSES_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const body = req.body || {};
        let items = [];
        if (Array.isArray(body.items)) items = body.items;
        else if (body.villaName && body.baselinePrice) items = [{ ...body, assetScore: body.assetScore || 150 }];
        else return res.status(400).json({ error: 'Missing required payload parameters.' });

        const now = Date.now();
        const t0 = Date.now();

        // Αν όλα τα items αφορούν μακρινούς μήνες (>60 ημέρες), δεν καθυστερούμε το request με εξωτερικά κλήσεις πτήσεων/Apify
        const needsLiveNearSignals = items.some(it => {
            const l = leadDays(parseMonth(it.month));
            return l === null || (l >= -10 && l <= 50);
        });

        const flights = { real: false, her: null, chq: null, total: null, intent: null, source: 'UNAVAILABLE' };
        const competitors = { real: false, occupancy: null, trend: null, sample: 0, source: 'UNAVAILABLE' };

        const fetchFlights = async () => {
            if (globalCache.flights.data && (now - globalCache.flights.timestamp < CACHE_TTL)) {
                Object.assign(flights, globalCache.flights.data, { source: 'CACHED' });
            } else if (AVIATION_API_KEY && needsLiveNearSignals) {
                try {
                    const [h, c] = await Promise.all([
                        axios.get(`http://api.aviationstack.com/v1/flights?access_key=${AVIATION_API_KEY}&arr_iata=HER&flight_status=scheduled&limit=100`, { timeout: 4500 }),
                        axios.get(`http://api.aviationstack.com/v1/flights?access_key=${AVIATION_API_KEY}&arr_iata=CHQ&flight_status=scheduled&limit=100`, { timeout: 4500 })
                    ]);
                    const her = num(h.data?.pagination?.total), chq = num(c.data?.pagination?.total);
                    if (her !== null && chq !== null) {
                        const total = her + chq;
                        const data = { real: true, her, chq, total, intent: total > 80 ? 'HIGH' : (total < 30 ? 'LOW' : 'NORMAL') };
                        Object.assign(flights, data, { source: 'LIVE' });
                        globalCache.flights = { data, timestamp: now };
                    }
                } catch (e) {
                    console.error('Aviation API Error:', e.message);
                }
            }
        };

        const fetchCompetitors = async () => {
            if (globalCache.market.data && (now - globalCache.market.timestamp < CACHE_TTL)) {
                Object.assign(competitors, globalCache.market.data, { source: 'CACHED' });
            } else if (APIFY_API_TOKEN && needsLiveNearSignals) {
                try {
                    const keys = Object.keys(DATASETS).filter(k => DATASETS[k]);
                    if (!keys.length) return;
                    const resp = await Promise.all(
                        keys.map(k => axios.get(`https://api.apify.com/v2/datasets/${DATASETS[k]}/items?token=${APIFY_API_TOKEN}&limit=50`, { timeout: 4500 }))
                    );
                    let occs = [], trends = [];
                    resp.forEach((r, i) => (Array.isArray(r.data) ? r.data : []).forEach(it => {
                        if (keys[i] === 'trends') {
                            const t = num(it.value ?? it.score ?? it.interest);
                            if (t !== null) trends.push(t);
                            return;
                        }
                        let o = num(it.occupancyRate ?? it.occupancy);
                        if (o === null) return;
                        if (o > 1) o = o / 100;
                        if (o >= 0 && o <= 1) occs.push(o);
                    }));
                    if (occs.length >= 5) {
                        const data = {
                            real: true,
                            occupancy: occs.reduce((a, b) => a + b, 0) / occs.length,
                            sample: occs.length,
                            trend: trends.length ? trends.reduce((a, b) => a + b, 0) / trends.length : null
                        };
                        Object.assign(competitors, data, { source: 'LIVE' });
                        globalCache.market = { data, timestamp: now };
                    }
                } catch (e) {
                    console.error('Apify Fetch Error:', e.message);
                }
            }
        };

        await Promise.all([fetchFlights(), fetchCompetitors()]);
        const ctx = { flights, competitors };
        const results = items.map(it => priceFor(it, ctx));

        const dataQuality = {
            flights: flights.source,
            competitors: competitors.source,
            keydata: items.some(i => i.market) ? 'PROVIDED' : 'MISSING',
            holidays: items.some(i => i.holidays) ? 'PROVIDED' : 'BUILTIN_CALENDAR'
        };

        if (!body.items && results.length === 1) {
            const r = results[0];
            return res.status(200).json({
                villa: r.villaName,
                baseline: r.baselinePrice,
                demandScore: r.demandScore,
                action: r.action,
                shadowRate: r.shadowRate,
                engineVersion: ENGINE_VERSION,
                range: r.range,
                confidence: r.confidence,
                quadrant: r.quadrant,
                metrics: r.metrics,
                recommendedMinStay: r.recommendedMinStay,
                drivers: r.drivers,
                beyond: r.beyond,
                explainability: r.explainability,
                dataQuality
            });
        }

        let aiSummary = null;
        const elapsedMs = Date.now() - t0;
        if (body.summary !== false && elapsedMs < 4500) {
            const ups = results.filter(r => r.action === 'YIELD_UP').length;
            const downs = results.filter(r => r.action === 'YIELD_DOWN').length;
            const holds = results.filter(r => r.action === 'HOLD').length;
            aiSummary = await getResilientAISummary(
                `Act as Chief Revenue Officer for Muses Curated Villas in Crete. In one concise, authoritative Greek sentence summarize: ${results.length} checks (${ups} αύξηση, ${downs} μείωση, ${holds} διατήρηση). Data: KeyData ${dataQuality.keydata}, Holidays ${dataQuality.holidays}, Flights ${flights.source}${flights.real ? ' (' + flights.total + ')' : ''}. No filler.`,
                Math.min(2800, 7500 - elapsedMs)
            );
        }

        res.status(200).json({
            success: true,
            engineVersion: ENGINE_VERSION,
            marketIntelligence: {
                flightsHER: flights.her,
                flightsCHQ: flights.chq,
                competitorOccupancy: competitors.occupancy,
                competitorTrend: competitors.trend,
                aiSummary,
                dataQuality
            },
            results
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}