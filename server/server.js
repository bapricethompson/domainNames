const express = require("express");
const cors = require("cors");
const { Ollama } = require("ollama");
const util = require("util");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const API_KEY = process.env.API_KEY;
const BASE_URL = "https://domainr.p.rapidapi.com/v2";
console.log(API_KEY);

const app = express();

app.use(express.json());

const corsOptions = {
  origin: ["http://localhost:3000", "http://localhost:5000"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use((req, res, next) => {
  console.log("Before CORS Middleware");
  next();
});

app.use(cors(corsOptions));

app.options("*", cors(corsOptions));

const ollama = new Ollama({ host: "http://100.64.0.1:11434" });
//const ollama = new Ollama({ host: "http://localhost:11434" });

const searchDomainToolSchema = {
  type: "function",
  function: {
    name: "searchDomains",
    description:
      "Returns domain name suggestions and variations based on a given query.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search term or keyword for domain suggestions (e.g., 'acme cafe').",
        },
      },
      required: ["query"],
    },
  },
};
const getDomainStatusToolSchema = {
  type: "function",
  function: {
    name: "getDomainStatus",
    description:
      "Checks and returns the availability and status of a list of domain names (up to 5). A status 'inactive' or 'undelegated' means available for registration; 'active' means unavailable. Rate limited to 5 checks.",
    parameters: {
      type: "object",
      properties: {
        domains: {
          type: "array",
          items: {
            type: "string",
            description:
              "A fully qualified domain name to check (e.g., 'acmecoffee.shop').",
          },
          description:
            "List of up to 5 domain names to check availability for.",
          maxItems: 5,
        },
      },
      required: ["domains"],
    },
  },
};
async function searchDomains(query) {
  console.log("HELLO");
  try {
    console.log("AQUI1");
    const url = `https://domainr.p.rapidapi.com/v2/search?query=${encodeURIComponent(
      query
    )}`;

    const response = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": API_KEY,
        "X-RapidAPI-Host": "domainr.p.rapidapi.com",
      },
    });

    console.log("searching");

    if (!response.ok) {
      throw new Error(
        `Error fetching search results: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error in searchDomains:", error.message);
    throw error; // re-throw so calling function can handle it
  }
}

async function getDomainStatus(domains) {
  const maxDomains = 5;
  const results = [];

  for (const domain of domains.slice(0, maxDomains)) {
    try {
      const url = `${BASE_URL}/status?domain=${encodeURIComponent(domain)}`;
      const response = await fetch(url, {
        headers: {
          "X-RapidAPI-Key": API_KEY,
          "X-RapidAPI-Host": "domainr.p.rapidapi.com",
        },
      });

      console.log("statusing", domain);
      if (!response.ok) {
        console.error(
          `Error fetching status for ${domain}: ${response.statusText}`
        );
        results.push({ domain, status: "error", error: response.statusText });
        continue;
      }

      const data = await response.json().catch(() => ({}));
      results.push(...(data.status || [{ domain, status: "error" }]));
    } catch (error) {
      console.error(`Error in API call for ${domain}:`, error.message);
      results.push({ domain, status: "error", error: error.message });
    }
  }

  return { status: results };
}

async function processToolCalls(messages, tools, model) {
  console.log("Calling Ollama...");
  const conversation = [...messages];

  const userMessage =
    conversation.find((msg) => msg.role === "user")?.content || "";
  const match = userMessage.match(
    /(?:words|keywords|based off these words)\s*([^.]*)/i
  );
  const keywords = match?.[1]?.trim().replace(/[^\w\s]/g, "") || "fallback";

  const vibeMatch = userMessage.match(/vibe\s*(.*)/i);
  const vibe = vibeMatch?.[1]?.trim() || "Any";

  const initialResponse = await ollama.chat({
    model,
    messages: conversation,
    tools,
    stream: false,
    options: { max_tokens: 2000 },
  });

  const assistantMessage = initialResponse.message;
  conversation.push(assistantMessage);

  let domainsToCheck = [];
  if (assistantMessage.tool_calls?.length) {
    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.function.name === "getDomainStatus") {
        domainsToCheck = toolCall.function.arguments.domains || [];
      }
    }
  }

  if (!domainsToCheck.length) {
    domainsToCheck = keywords
      .split(/\s+/)
      .slice(0, 2)
      .map((k, i) => `${k.toLowerCase()}${i + 1}.com`);
  }

  const statusData = await getDomainStatus(domainsToCheck);
  const baseSuggestions = (statusData.status || []).map((s, i) => ({
    domain: s.domain ? s.domain.split(".")[0] : domainsToCheck[i].split(".")[0],
    tld: s.domain?.includes(".") ? "." + s.domain.split(".").pop() : ".com",
    available:
      s.status?.includes("inactive") || s.status?.includes("undelegated"),
  }));

  const reasoningPrompt = `
Here are some domain availability results: ${JSON.stringify(baseSuggestions)}.
Please provide a JSON object with the same domains and tlds, but include a short creative "reason" for each one explaining why it fits the keywords "${keywords}" and vibe "${vibe}".
Return only valid JSON in this format:
{
  "suggestions": [
    { "domain": "...", "tld": "...", "available": true, "reason": "..." }
  ]
}
  `;

  const reasoningResponse = await ollama.chat({
    model,
    messages: [...conversation, { role: "user", content: reasoningPrompt }],
    stream: false,
  });

  let finalSuggestions = [];
  try {
    const parsed = JSON.parse(reasoningResponse.message.content);
    finalSuggestions =
      parsed.suggestions ||
      baseSuggestions.map((s) => ({
        ...s,
        reason: `Generated for vibe: ${vibe}, using keywords: ${keywords}`,
      }));
  } catch (err) {
    console.error("Error parsing Ollama reasoning response", err);
    // fallback: attach generic reason
    finalSuggestions = baseSuggestions.map((s) => ({
      ...s,
      reason: `Generated for vibe: ${vibe}, using keywords: ${keywords}`,
    }));
  }

  return {
    message: {
      role: "assistant",
      content: JSON.stringify({ suggestions: finalSuggestions }, null, 2),
    },
    toolCalls: assistantMessage.tool_calls || [],
    toolResults: [statusData],
  };
}

app.post("/domains", async (req, res) => {
  try {
    const requestData = req.body;

    console.log("Reuest data:", requestData.messages);

    console.log("KEY", API_KEY);

    const tools = [searchDomainToolSchema, getDomainStatusToolSchema];

    console.log("im here");
    const result = await processToolCalls(
      requestData.messages,
      [getDomainStatusToolSchema],
      requestData.model
    );
    console.log("im here 2");
    console.log(result.message);

    res.json({ message: { content: result.message.content } });
  } catch (error) {
    console.error("Error proxying to golem:", error);
    res.status(500).json({ error: "Failed to fetch from golem" });
  }
});

// app.post("/domains", (req, res) => {
//   res.json({
//     message: {
//       content:
//         '{"suggestions":[{"domain":"test","tld":".com","reason":"demo","available":true}]}',
//     },
//   });
// });

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
