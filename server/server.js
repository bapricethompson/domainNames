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
  console.log("message", messages);
  console.log("tools", tools);

  // Start with a copy of messages to avoid mutating original
  let conversation = [...messages];
  const maxToolCalls = 5; // Max API calls to respect rate limit
  let totalToolCalls = 0;
  const suggestions = [];
  const toolResults = [];

  // Helper to extract keywords from user message for better fallbacks
  const userMessage =
    conversation.find((msg) => msg.role === "user")?.content || "";

  console.log("USER MESSAGE", userMessage);
  const match = userMessage.match(
    /(?:words|keywords|based off these words)\s*([^.]*)/i
  );
  const keywords = match?.[1]?.trim().replace(/[^\w\s]/g, "") || "fallback";
  const getFallbackDomain = (index) => {
    const parts = keywords.split(/\s+/).slice(0, 2).join("-").toLowerCase();
    return `${parts}${index}.com`;
  };

  // Single-turn processing (since we expect one getDomainStatus call with multiple domains)
  const response = await ollama.chat({
    model,
    messages: conversation,
    tools,
    stream: false,
    options: { max_tokens: 2000 },
  });
  console.log("Ollama finished");
  console.log("Ollama response:", util.inspect(response, false, null, true));
  console.log(
    "Number of tool calls received:",
    response.message?.tool_calls?.length || 0
  );
  console.log("Model thinking:", response.message?.thinking || "None");

  const assistantMessage = response.message;
  conversation.push(assistantMessage);

  if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.function.name === "getDomainStatus") {
        const domains = toolCall.function.arguments.domains || [];
        if (domains.length === 0) {
          console.log("No domains provided in tool call, skipping.");
          continue;
        }

        try {
          const data = await getDomainStatus(domains);
          totalToolCalls += Math.min(
            domains.length,
            maxToolCalls - totalToolCalls
          );

          // Append tool result to conversation
          conversation.push({
            role: "tool",
            content: JSON.stringify(data),
            tool_call_id: toolCall.id || `call_${totalToolCalls}`,
          });

          // Add to suggestions
          suggestions.push(
            ...(data.status || []).map((s) => ({
              domain: s.domain
                ? s.domain.split(".")[0]
                : domains[0].split(".")[0],
              tld: s.domain?.includes(".")
                ? "." + s.domain.split(".").pop()
                : ".com",
              reason: `Status check for ${s.domain} (based on keywords: ${keywords})`,
              available:
                s.status?.includes("inactive") ||
                s.status?.includes("undelegated"),
            }))
          );

          toolResults.push(data);
          console.log(`Processed tool call for domains: ${domains.join(", ")}`);
        } catch (error) {
          console.error("Error in getDomainStatus tool call:", error);
          conversation.push({
            role: "tool",
            content: JSON.stringify({ error: error.message }),
            tool_call_id: toolCall.id || `call_${totalToolCalls}`,
          });
        }
      } else if (toolCall.function.name === "searchDomains") {
        const query = toolCall.function.arguments.query;
        try {
          const data = await searchDomains(query);
          conversation.push({
            role: "tool",
            content: JSON.stringify(data),
            tool_call_id: toolCall.id || `call_${totalToolCalls}`,
          });
          toolResults.push({ type: "search", data });
        } catch (error) {
          console.error("Error in searchDomains tool call:", error);
          conversation.push({
            role: "tool",
            content: JSON.stringify({ error: error.message }),
            tool_call_id: toolCall.id || `call_${totalToolCalls}`,
          });
        }
      }
    }
  }
  console.log("SUGGESTIONS", suggestions);
  // Fallback: Fill to exactly 5 with keyword-based domains if needed
  while (suggestions.length < 5 && totalToolCalls < maxToolCalls) {
    const fallbackDomain = getFallbackDomain(suggestions.length + 1);
    try {
      const data = await getDomainStatus([fallbackDomain]); // Pass as array for consistency
      totalToolCalls++;
      suggestions.push(
        ...(data.status || []).map((s) => ({
          domain: s.domain
            ? s.domain.split(".")[0]
            : fallbackDomain.split(".")[0],
          tld: s.domain?.includes(".")
            ? "." + s.domain.split(".").pop()
            : ".com",
          reason: `Creative fallback for ${s.domain} (inspired by ${keywords})`,
          available:
            s.status?.includes("inactive") || s.status?.includes("undelegated"),
        }))
      );
      toolResults.push(data);
      console.log(`Fallback call ${suggestions.length}: ${fallbackDomain}`);
    } catch (error) {
      console.error("Fallback error:", error);
    }
  }

  // Trim to exactly 5
  const finalSuggestions = suggestions.slice(0, 5);

  const finalContent = JSON.stringify(
    { suggestions: finalSuggestions },
    null,
    2
  );

  return {
    message: { role: "assistant", content: finalContent },
    toolCalls: assistantMessage.tool_calls || [],
    toolResults,
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
