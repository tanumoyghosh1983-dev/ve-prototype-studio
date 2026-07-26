// Netlify Function: save-prototype.js
// Stores a generated prototype in Netlify Blobs under a short random ID,
// so it can be retrieved later via a shareable link (/p.html?id=...).
// No API key needed — Netlify Blobs is built into the platform.

const { connectLambda, getStore } = require("@netlify/blobs");

function makeShortId() {
  // 8 chars of base36 — ~2.8 trillion possibilities, short enough to be a
  // clean URL, long enough that guessing a real ID is not practical.
  return Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
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

  let prototype;
  try {
    const body = JSON.parse(event.body || "{}");
    prototype = body.prototype;
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  if (!prototype || !Array.isArray(prototype.screens) || prototype.screens.length === 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing or invalid prototype data" }),
    };
  }

  // Basic size guard — a reasonable prototype is a few KB to maybe 50KB with
  // image URLs included. Reject anything absurd rather than storing garbage.
  const serialized = JSON.stringify(prototype);
  if (serialized.length > 500_000) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Prototype data is too large to save" }),
    };
  }

  try {
    connectLambda(event);
    const store = getStore("prototypes");

    // Try a few times in the astronomically unlikely case of an ID collision.
    let id;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = makeShortId();
      const existing = await store.get(candidate);
      if (existing === null) {
        id = candidate;
        break;
      }
    }
    if (!id) {
      throw new Error("Could not generate a unique ID");
    }

    await store.setJSON(id, {
      prototype,
      createdAt: new Date().toISOString(),
    });

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message || "Failed to save prototype" }),
    };
  }
};
