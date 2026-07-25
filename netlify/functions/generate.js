// Netlify Function: generate.js
// Proxies prototype-generation requests to the Gemini API (Google AI Studio).
// The real API key lives ONLY in Netlify's environment variables (server-side),
// never in the browser bundle. Set GEMINI_API_KEY in Netlify site settings.

const SYSTEM_PROMPT = `You are a senior product designer generating a JSON specification for an interactive mobile app prototype based on a user's plain-English description. This will be rendered as clickable HTML/CSS screens inside a phone frame.

Respond with ONLY valid JSON, no markdown fences, no preamble, matching this exact schema:

{
  "appName": "string, short catchy app name",
  "primaryColor": "#hexcolor - pick a color that fits the app's domain, NOT necessarily orange/coral",
  "screens": [
    {
      "id": "unique_screen_id",
      "title": "Screen Title",
      "type": "one of: splash, onboarding, home, list, detail, form, profile, cart, checkout, confirmation, map, chat, dashboard, settings",
      "components": [
        {"kind": "header", "text": "..."},
        {"kind": "text", "text": "...", "style": "heading|body|caption"},
        {"kind": "card", "title": "...", "subtitle": "...", "image_emoji": "an emoji representing this item", "navTo": "screen_id or null"},
        {"kind": "button", "label": "...", "navTo": "screen_id", "style": "primary|secondary"},
        {"kind": "input", "placeholder": "..."},
        {"kind": "list_row", "title": "...", "subtitle": "...", "trailing": "...", "navTo": "screen_id or null"},
        {"kind": "stat", "value": "...", "label": "..."},
        {"kind": "tabbar", "items": ["Home","Search","Cart","Profile"], "navMap": {"Home":"screen_id","Search":"screen_id"}},
        {"kind": "image_banner", "image_emoji": "emoji", "caption": "..."},
        {"kind": "map_placeholder", "caption": "..."},
        {"kind": "divider"},
        {"kind": "spacer"}
      ]
    }
  ],
  "startScreen": "screen_id of first screen"
}

Rules:
- Generate 5-9 screens that form a coherent, navigable flow specific to the user's app idea (not generic).
- Every interactive element (card, button, list_row) that logically leads somewhere should have a navTo pointing to a real screen id in your screens array.
- Every tabbar item's navMap target must also be a real screen id in your screens array. Never reference a screen id that isn't in your screens list.
- Include realistic, specific placeholder content (names, prices, statuses) relevant to the app's domain — not lorem ipsum.
- Include a tabbar component on every "main" screen (the ones reachable from other main screens) for realistic, consistent navigation, with 3-5 items.
- Keep each screen to 6-14 components so it fits a phone screen reasonably.
- The first screen in the array should match startScreen.
- Output ONLY the JSON object, nothing else.`;

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Server is missing GEMINI_API_KEY. Set it in Netlify site environment variables.",
      }),
    };
  }

  let prompt;
  try {
    const body = JSON.parse(event.body || "{}");
    prompt = (body.prompt || "").trim();
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  if (!prompt) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing 'prompt' field" }),
    };
  }

  if (prompt.length > 2000) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Prompt too long (max 2000 characters)" }),
    };
  }

  // Gemini's native REST endpoint. Auth via x-goog-api-key header works for
  // both legacy "AIza..." standard keys and the newer "AQ." auth keys.
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    const geminiRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${SYSTEM_PROMPT}\n\nApp idea: ${prompt}` }],
          },
        ],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 4000,
          responseMimeType: "application/json",
        },
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return {
        statusCode: geminiRes.status,
        headers,
        body: JSON.stringify({
          error: data?.error?.message || "Gemini API request failed",
        }),
      };
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Gemini returned an empty response");
    }

    let cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/```\s*$/, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error("Could not parse model output as JSON");
      }
    }

    if (
      !parsed.screens ||
      !Array.isArray(parsed.screens) ||
      parsed.screens.length === 0 ||
      !parsed.startScreen
    ) {
      throw new Error("Generated prototype was missing required fields");
    }

    // Safety net: redirect any dangling navTo/navMap references to the start
    // screen, so a malformed model response never produces a dead button.
    const validIds = new Set(parsed.screens.map((s) => s.id));
    for (const s of parsed.screens) {
      for (const c of s.components || []) {
        if (c.navTo && !validIds.has(c.navTo)) c.navTo = parsed.startScreen;
        if (c.navMap) {
          for (const k of Object.keys(c.navMap)) {
            if (!validIds.has(c.navMap[k])) c.navMap[k] = parsed.startScreen;
          }
        }
      }
    }

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message || "Failed to generate prototype" }),
    };
  }
};
