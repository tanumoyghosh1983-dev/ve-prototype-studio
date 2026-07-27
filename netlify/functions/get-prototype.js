// Netlify Function: get-prototype.js
// Retrieves a previously-saved prototype by its short ID.

const { connectLambda, getStore } = require("@netlify/blobs");

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const id = event.queryStringParameters && event.queryStringParameters.id;
  if (!id || !/^[a-z0-9]{1,20}$/i.test(id)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing or invalid id parameter" }),
    };
  }

  try {
    connectLambda(event);
    console.log("[get-prototype] connectLambda succeeded, looking up id:", id);
    const store = getStore("prototypes");
    const record = await store.get(id, { type: "json" });
    console.log("[get-prototype] lookup result:", record ? "FOUND" : "NOT FOUND");

    if (!record) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "This prototype link doesn't exist or has expired." }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(record.prototype),
    };
  } catch (err) {
    console.log("[get-prototype] ERROR:", err.message, err.stack);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message || "Failed to retrieve prototype" }),
    };
  }
};
