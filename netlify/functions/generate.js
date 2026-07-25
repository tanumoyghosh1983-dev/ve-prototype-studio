// Netlify Function: generate.js
// Proxies prototype-generation requests to the Gemini API (Google AI Studio).
// The real API key lives ONLY in Netlify's environment variables (server-side),
// never in the browser bundle. Set GEMINI_API_KEY in Netlify site settings.

const SYSTEM_PROMPT = `You are a senior product designer generating a JSON specification for an interactive mobile app prototype based on a user's plain-English description. This will be rendered as clickable HTML/CSS screens inside a phone frame.

FIRST, decide whether the user's input actually describes an app concept you can design screens for. It does NOT if it is: a question about this tool itself, a greeting, a single vague word, gibberish, or anything you cannot turn into a specific mobile app.

Respond with ONLY valid JSON, no markdown fences, no preamble, in ONE of these two shapes:

SHAPE A — if the input IS a describable app idea:
{
  "isValidAppIdea": true,
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

SHAPE B — if the input is NOT a describable app idea:
{
  "isValidAppIdea": false,
  "reason": "one short, plain-English sentence explaining why this isn't an app idea",
  "suggestion": "one short, plain-English example app idea the user could try instead, written as a ready-to-use prompt"
}

EXAMPLES (learn the boundary from these):

Input: "what kind of app can you build?"
Output: {"isValidAppIdea": false, "reason": "That's a question about this tool, not a description of an app.", "suggestion": "Try something like: a food delivery app with live order tracking"}

Input: "help"
Output: {"isValidAppIdea": false, "reason": "That's too vague to design screens from.", "suggestion": "Try something like: a fitness app with workout plans and progress charts"}

Input: "hi"
Output: {"isValidAppIdea": false, "reason": "That's a greeting, not an app idea.", "suggestion": "Try something like: a ride-hailing app like Uber"}

Input: "asdkfjasdf"
Output: {"isValidAppIdea": false, "reason": "That doesn't describe anything I can design around.", "suggestion": "Try something like: a marketplace app for renting furniture"}

Input: "a ride-hailing app like Uber"
Output: {"isValidAppIdea": true, "appName": "GoNow", "primaryColor": "#000000", "startScreen": "home", "screens": [...full screens array...]}

Input: "an app for booking hair salon appointments"
Output: {"isValidAppIdea": true, "appName": "SlotWise", "primaryColor": "#8E44AD", "startScreen": "home", "screens": [...full screens array...]}

RULES FOR SHAPE A (valid app ideas):
- Generate 5-9 screens that form a coherent, navigable flow specific to the user's app idea (not generic).
- Every interactive element (card, button, list_row) that logically leads somewhere should have a navTo pointing to a real screen id in your screens array.
- Every tabbar item's navMap target must also be a real screen id in your screens array. Never reference a screen id that isn't in your screens list.
- Include realistic, specific placeholder content (names, prices, statuses) relevant to the app's domain — not lorem ipsum.
- Include a tabbar component on every "main" screen (the ones reachable from other main screens) for realistic, consistent navigation, with 3-5 items.
- Keep each screen to 6-14 components so it fits a phone screen reasonably.
- The first screen in the array should match startScreen.

Output ONLY the JSON object, nothing else.`;

const CONCISE_ADDENDUM = `

IMPORTANT ADDITIONAL CONSTRAINT: Your previous attempt at this ran out of space before finishing. This time, be more concise: use exactly 5 screens, keep each screen to 6-8 components maximum, and keep all text fields short. Prioritize finishing the JSON completely over including every detail.`;

// Attempts to repair JSON that was cut off mid-structure (a common symptom of
// hitting the model's output token limit). Truncation almost always happens
// at a clean nesting boundary, so counting open vs. closed brackets/braces
// and closing whatever's left open recovers a valid, if slightly shorter,
// object in the large majority of cases.
function repairTruncatedJSON(text) {
  let s = text.trim();

  // Trim any trailing partial token (e.g. a dangling comma, an incomplete
  // string, or a key with no value yet) back to the last safe boundary.
  const lastSafe = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (lastSafe > 0 && lastSafe < s.length - 1) {
    // There's content after the last complete structure — likely a partial
    // trailing element. Try repairing from here first.
  }

  // Count unmatched brackets/braces, respecting string literals so we don't
  // count braces that appear inside quoted text.
  let stack = [];
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  let repaired = s;

  // If we ended mid-string, close the string first.
  if (inString) repaired += '"';

  // If the last non-whitespace character suggests a dangling comma or an
  // incomplete key/value, trim back to the last complete element.
  repaired = repaired.replace(/,\s*$/, "");
  repaired = repaired.replace(/:\s*$/, ": null");

  // Close any remaining open brackets/braces in reverse order.
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === "{" ? "}" : "]";
  }

  return repaired;
}

// Calls Gemini's native generateContent endpoint once and returns the raw
// text response. Throws on network/API failure.
async function callGemini(apiKey, model, promptText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const geminiRes = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 8000,
        responseMimeType: "application/json",
      },
    }),
  });

  const data = await geminiRes.json();

  if (!geminiRes.ok) {
    const err = new Error(data?.error?.message || "Gemini API request failed");
    err.statusCode = geminiRes.status;
    throw err;
  }

  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return text;
}

// Cleans markdown fences and attempts to parse JSON, falling back to
// bracket-repair if the response was truncated mid-structure.
function parseModelJSON(rawText) {
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "")
    .trim();

  try {
    return { parsed: JSON.parse(cleaned), wasRepaired: false };
  } catch (e) {
    // First fallback: extract the outermost { ... } block in case there's
    // stray text around it, then try parsing that directly.
    const match = cleaned.match(/\{[\s\S]*\}/);
    const candidate = match ? match[0] : cleaned;
    try {
      return { parsed: JSON.parse(candidate), wasRepaired: false };
    } catch (e2) {
      // Second fallback: attempt structural repair of truncated JSON.
      try {
        const repaired = repairTruncatedJSON(candidate);
        return { parsed: JSON.parse(repaired), wasRepaired: true };
      } catch (e3) {
        return { parsed: null, wasRepaired: false };
      }
    }
  }
}

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

  const model = "gemini-3.5-flash";
  const basePromptText = `${SYSTEM_PROMPT}\n\nApp idea: ${prompt}`;

  try {
    // Attempt 1: normal generation.
    let rawText = await callGemini(apiKey, model, basePromptText);
    let { parsed, wasRepaired } = parseModelJSON(rawText);

    // Decide whether what we have is actually usable. Parsing can "succeed"
    // via bracket-repair yet still leave us with too little to render (e.g.
    // the truncation cut off nearly everything). Treat that the same as a
    // parse failure for retry purposes.
    function isUsable(p) {
      if (!p || typeof p.isValidAppIdea !== "boolean") return false;
      if (p.isValidAppIdea === false) return true; // valid "not an app idea" response
      const screens = Array.isArray(p.screens)
        ? p.screens.filter((s) => s && s.id && Array.isArray(s.components) && s.components.length > 0)
        : [];
      return screens.length >= 3; // need enough screens for a usable prototype
    }

    // Attempt 2 (silent, automatic): if the first attempt didn't produce a
    // usable result — whether from a hard parse failure or from truncation
    // that repair could only partially rescue — retry once with an explicit
    // instruction to be more concise. The person never sees this happen; it
    // just looks like a normal (if slightly slower) generation.
    if (!isUsable(parsed)) {
      rawText = await callGemini(apiKey, model, basePromptText + CONCISE_ADDENDUM);
      ({ parsed, wasRepaired } = parseModelJSON(rawText));
    }

    if (!isUsable(parsed)) {
      throw new Error(
        "That idea generated a longer response than usual and didn't come through cleanly. Please try again, or simplify the description a little."
      );
    }

    if (typeof parsed.isValidAppIdea !== "boolean") {
      throw new Error("Model response was missing the isValidAppIdea field");
    }

    if (parsed.isValidAppIdea === false) {
      // Not an app idea — return a friendly, structured "try again" response.
      // This is a normal, expected outcome, not an error condition.
      return {
        statusCode: 200,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          isValidAppIdea: false,
          reason: parsed.reason || "That doesn't look like an app idea yet.",
          suggestion:
            parsed.suggestion ||
            "Try something like: a food delivery app with live order tracking",
        }),
      };
    }

    // isValidAppIdea === true from here on — validate it's a usable prototype.
    if (
      !parsed.screens ||
      !Array.isArray(parsed.screens) ||
      parsed.screens.length === 0 ||
      !parsed.startScreen
    ) {
      throw new Error("Generated prototype was missing required fields");
    }

    // If repair had to trim the tail of the screens array, the last screen
    // may be incomplete (missing components, etc). Drop any screen that
    // doesn't have a usable components array so nothing renders broken.
    if (wasRepaired) {
      parsed.screens = parsed.screens.filter(
        (s) => s && s.id && Array.isArray(s.components)
      );
      if (parsed.screens.length === 0 || !parsed.screens.some((s) => s.id === parsed.startScreen)) {
        parsed.startScreen = parsed.screens[0]?.id;
      }
      if (!parsed.startScreen) {
        throw new Error(
          "That idea generated a longer response than usual and didn't come through cleanly. Please try again, or simplify the description a little."
        );
      }
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
      statusCode: err.statusCode || 502,
      headers,
      body: JSON.stringify({ error: err.message || "Failed to generate prototype" }),
    };
  }
};
