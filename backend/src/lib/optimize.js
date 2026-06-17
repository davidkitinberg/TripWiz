'use strict';

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

// [Review #2] AI route-optimization logic (Amazon Bedrock prompt construction +
// response parsing) extracted from the REST monolith into its own module.

const bedrock = new BedrockRuntimeClient({});
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

function classifyStop(name) {
  const n = (name || '').toLowerCase();
  if (/airport|terminal|departure|arrival|airline|airways|fly|flight/.test(n)) return 'airport';
  if (/train station|bus station|bus terminal|railway|central station|ferry terminal|port terminal|metro station/.test(n)) return 'transit';
  if (/hotel|hostel|inn|lodge|resort|motel|airbnb|accommodation|check.?in|check.?out|ritz|hilton|marriott|sheraton|hyatt/.test(n)) return 'hotel';
  return 'attraction';
}

// [Feature #20] AI route optimization via Amazon Bedrock (Claude Haiku 4.5)
async function optimizeWithBedrock(itinerary) {
  const raw = (itinerary || []).filter((s) => s && s.coords && s.coords.lat != null && s.coords.lng != null);

  if (raw.length < 2) {
    return { stops: [], reasoning: 'Need at least 2 stops with coordinates to optimize a route.' };
  }

  // Group by day to determine each stop's position within its day
  const byDay = {};
  for (const s of raw) {
    const d = s.dayIndex || 0;
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(s);
  }
  for (const day of Object.values(byDay)) {
    day.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    day.forEach((s, i) => { s._dayPos = i; s._dayLen = day.length; });
  }

  const stops = raw.map((s) => {
    const type = classifyStop(s.title);
    const scheduledTime = s.start ? s.start.substring(11, 16) : null;
    const isFixed = type === 'airport' || type === 'transit';
    const isFirstInDay = s._dayPos === 0;
    const isLastInDay = s._dayPos === s._dayLen - 1;
    return {
      stopId: s.slotId,
      name: s.title || 'Unnamed stop',
      type,
      isFixed,
      ...(scheduledTime ? { scheduledTime } : {}),
      ...(type === 'hotel' ? { isFirstInDay, isLastInDay } : {}),
      dayIndex: s.dayIndex || 0,
      lat: s.coords.lat,
      lng: s.coords.lng,
      durationHours: s.duration || s.notes || '2'
    };
  });

  const systemPrompt = `You are TripWiz, an expert travel planner with deep knowledge of geography, logistics, and creating memorable travel experiences. When given a list of trip stops you reorder them day-by-day into the most logical, efficient, and enjoyable itinerary possible. You reason carefully about geography, travel time, meal timing, attraction types, and practical constraints.

CRITICAL CONSTRAINT — AIRPORTS, FLIGHTS & TERMINALS (ABSOLUTELY NON-NEGOTIABLE):
Any stop with type "airport" or "transit", OR whose name contains words like "airport", "terminal", "flight", "departure", or "arrival", is a FIXED TIME ANCHOR. You MUST:
- Keep it on its EXACT dayIndex — never reassign it to a different day
- Output its scheduledTime UNCHANGED in your JSON — do not alter it by even one minute
- Never reorder it relative to other fixed stops on the same day
These are real-world flights with real consequences. There are ZERO exceptions to this rule.`;

  const userPrompt = `Analyze the following trip itinerary and produce a detailed optimized schedule.

Stops:
${JSON.stringify(stops, null, 2)}

Rules:
1. NEVER change dayIndex or scheduledTime for any stop where isFixed=true. Output their times exactly as given.
2. Hotels obey isFirstInDay / isLastInDay — a check-out hotel must remain first in its day; a check-in hotel must remain last.
3. Reorder attraction stops within each day to minimize travel distance (use lat/lng) and create a pleasant, logical flow: breakfast cafes early morning, museums and landmarks mid-morning, parks and outdoor sights in the afternoon, restaurants at meal times.
4. Assign startTime for every stop in "HH:MM" 24-hour format. First attraction no earlier than 09:00; last stop should finish by 22:00. Allow 15 min travel buffer between stops plus each stop's durationHours (use the lower bound of any range).
5. Never move a stop to a different day. Never add or remove any stop.
6. Use exactly the stopIds provided.

Respond with ONLY a valid JSON object — absolutely no markdown fences, no prose outside the JSON:
{
  "stops": [
    {"stopId": "<id>", "dayIndex": <int>, "startTime": "HH:MM"}
  ],
  "reasoning": "Write 3-5 detailed paragraphs explaining your overall strategy: the geographic logic you used, how you handled any fixed anchors, why certain stops are grouped together, and the general experience you are trying to create for the traveler.",
  "dailySummary": [
    {
      "dayIndex": <int>,
      "heading": "Day N — <evocative theme or neighborhood name>",
      "description": "Write 3-5 sentences describing this specific day in detail: what the traveler will experience in sequence, why this order makes geographic and experiential sense, any notable transitions between areas, how travel time was managed, and what makes this day's flow enjoyable."
    }
  ]
}`;

  const res = await bedrock.send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  }));

  // In SDK v3, res.body is a Uint8Array
  const body = JSON.parse(Buffer.from(res.body).toString('utf8'));
  const text = (body.content && body.content[0] && body.content[0].text) || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    const e = new Error('Bedrock did not return parseable JSON');
    e.statusCode = 502;
    e.code = 'BEDROCK_PARSE_ERROR';
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    const e = new Error('Bedrock returned invalid JSON');
    e.statusCode = 502;
    e.code = 'BEDROCK_PARSE_ERROR';
    throw e;
  }

  const validIds = new Set(stops.map((s) => s.stopId));
  const cleanedStops = (parsed.stops || [])
    .filter((p) => p && validIds.has(p.stopId))
    .map((p) => ({
      stopId: p.stopId,
      dayIndex: Number.isInteger(p.dayIndex) ? p.dayIndex : 0,
      startTime: typeof p.startTime === 'string' && /^\d{2}:\d{2}$/.test(p.startTime) ? p.startTime : ''
    }));

  const dailySummary = Array.isArray(parsed.dailySummary)
    ? parsed.dailySummary
        .filter((d) => d && Number.isInteger(d.dayIndex) && typeof d.description === 'string')
        .map((d) => ({
          dayIndex: d.dayIndex,
          heading: typeof d.heading === 'string' ? d.heading : `Day ${d.dayIndex + 1}`,
          description: d.description
        }))
    : [];

  return {
    stops: cleanedStops,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    dailySummary,
    model: BEDROCK_MODEL_ID
  };
}

module.exports = { classifyStop, optimizeWithBedrock };
