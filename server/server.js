const express = require("express");
const cors = require("cors");
const { ChatOllama } = require("@langchain/ollama");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, ToolMessage } = require("@langchain/core/messages");
const { StateGraph, START, END } = require("@langchain/langgraph");
const { StructuredTool } = require("@langchain/core/tools");
const { z } = require("zod");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const API_KEY = process.env.API_KEY;
const BASE_URL = "https://domainr.p.rapidapi.com/v2";

const app = express();
const port = 4000;

app.use(express.json());
app.use(cors());

const corsOptions = {
  origin: [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

const llm = new ChatOpenAI({
  apiKey: "",
  configuration: {
    baseURL: "http://100.64.0.1:11434/v1",
  },
  model: "gpt-oss:20b",
});

// const llm = new ChatOllama({
//   baseUrl: "http://100.64.0.1:11434",
//   model: "gpt-oss:20b",
// });

// ------------------- TOOLS -------------------

class SearchDomainsTool extends StructuredTool {
  name = "searchDomains";
  description = "Returns domain name suggestions based on a given query.";

  schema = z.object({
    query: z
      .string()
      .describe(
        "The keyword or phrase to search domains for (e.g., 'acme cafe')."
      ),
  });

  async _call({ query }) {
    try {
      const url = `${BASE_URL}/search?query=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: {
          "X-RapidAPI-Key": API_KEY,
          "X-RapidAPI-Host": "domainr.p.rapidapi.com",
        },
      });

      if (!response.ok) {
        throw new Error(`Domainr API search error: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (err) {
      console.error("Error in searchDomains:", err.message);
      return { error: err.message };
    }
  }
}

class GetDomainStatusTool extends StructuredTool {
  name = "getDomainStatus";
  description =
    "Checks availability of up to 5 domains. Status 'inactive' or 'undelegated' = available.";

  schema = z.object({
    domains: z
      .array(z.string())
      .max(5)
      .describe(
        "List of up to 5 fully qualified domain names (e.g., acme.com)."
      ),
  });

  async _call({ domains }) {
    const results = [];
    for (const domain of domains) {
      try {
        const url = `${BASE_URL}/status?domain=${encodeURIComponent(domain)}`;
        const response = await fetch(url, {
          headers: {
            "X-RapidAPI-Key": API_KEY,
            "X-RapidAPI-Host": "domainr.p.rapidapi.com",
          },
        });

        if (!response.ok) {
          results.push({ domain, status: "error" });
          continue;
        }
        const data = await response.json();
        results.push(...(data.status || [{ domain, status: "error" }]));
      } catch (err) {
        results.push({ domain, status: "error", error: err.message });
      }
    }
    return { status: results };
  }
}

class DomainRankingTool extends StructuredTool {
  name = "rankDomains";
  description = "Ranks domains based on quality, length, and TLD popularity.";

  schema = z.object({
    domains: z
      .array(z.string())
      .min(1)
      .describe("A list of domain names to rank."),
  });

  async _call({ domains }) {
    try {
      console.log("Ranking domains:", domains);
      const tldWeights = {
        ".com": 10,
        ".net": 8,
        ".org": 7,
        ".io": 6,
        ".co": 6,
        ".ai": 5,
      };

      const scored = domains.map((domain) => {
        const lengthScore = Math.max(0, 20 - domain.length); // shorter = better
        const tld = domain.substring(domain.lastIndexOf("."));
        const tldScore = tldWeights[tld] || 3;
        const hasHyphen = domain.includes("-");
        const hasNumber = /\d/.test(domain);
        const penalty = (hasHyphen ? 3 : 0) + (hasNumber ? 2 : 0);

        const score = lengthScore + tldScore - penalty;
        return { domain, score };
      });

      // sort highest first
      scored.sort((a, b) => b.score - a.score);

      return {
        ranked: scored,
        top: scored[0],
      };
    } catch (err) {
      console.error("Error in rankDomains:", err.message);
      return { error: err.message };
    }
  }
}

class MakeDecisionTool extends StructuredTool {
  name = "makeDecision";
  description =
    "Randomly chooses the next action: either to check domain rankings or check trademark classes.";

  async _call() {
    console.log("DecisionTool: Making a decision...");
    const options = ["rank", "trademark"];
    const choice = options[Math.floor(Math.random() * options.length)];
    console.log(`DecisionTool: Selected "${choice}"`);
    return choice;
  }
}

class CheckTrademarkTool extends StructuredTool {
  name = "checkTrademarks";
  description =
    "Checks if any of the provided domain names may have potential trademark conflicts.";

  schema = z.object({
    domains: z
      .array(z.string())
      .min(1)
      .describe("A list of domain names to check for trademark conflicts."),
  });

  async _call({ domains }) {
    try {
      // ⚠️ For now, simulate a check — you could later connect to a real trademark API.
      const knownBrands = [
        "google",
        "facebook",
        "nike",
        "apple",
        "amazon",
        "disney",
      ];

      const results = domains.map((domain) => {
        const base = domain.split(".")[0].toLowerCase();
        const conflict = knownBrands.some((brand) => base.includes(brand));
        return {
          domain,
          trademarkConflict: conflict,
          status: conflict ? "Potential Conflict" : "Clear",
        };
      });

      return { results };
    } catch (err) {
      console.error("Error in checkTrademarks:", err.message);
      return { error: err.message };
    }
  }
}

const searchTool = new SearchDomainsTool();
const statusTool = new GetDomainStatusTool();
const rankingTool = new DomainRankingTool();
const trademarkTool = new CheckTrademarkTool();
const decisionTool = new MakeDecisionTool();

// ------------------- LANGGRAPH -------------------

const graphStateData = {
  query: "",
  result: "",
  decision: "",
  //toolResults: [],
  //domainsChecked: false,
};

async function domainNode(state) {
  console.log("DOMAIN NODE STATE:", state);

  const message = new HumanMessage({
    content: [
      {
        type: "text",
        text: ` ${state.query} Respond only with valid JSON in this format "suggestions":["domain":"...", "tld":".com", "reason":"...","available":true},...]}`,
      },
    ],
  });

  // Bind both tools to the LLM
  const llmWithTool = llm.bind({ tools: [searchTool, statusTool] });
  const response = await llmWithTool.invoke([message]);

  const toolCall = response.tool_calls?.[0];

  if (toolCall) {
    let toolResult;
    if (toolCall.name === "searchDomains") {
      toolResult = await searchTool.invoke(toolCall.args);
    } else if (toolCall.name === "getDomainStatus") {
      toolResult = await statusTool.invoke(toolCall.args);
    } else {
      console.warn("Unknown tool requested:", toolCall.name);
      return { result: response.content };
    }

    let toolSummary = "";

    // Search tool returns .results, Status tool returns .status
    if (toolResult?.results && Array.isArray(toolResult.results)) {
      toolSummary = toolResult.results
        .slice(0, 5)
        .map((d) => d.domain || d.name || JSON.stringify(d))
        .join(", ");
    } else if (toolResult?.status && Array.isArray(toolResult.status)) {
      toolSummary = toolResult.status
        .slice(0, 5)
        .map((d) => `${d.domain} (${d.summary})`)
        .join(", ");
    } else {
      toolSummary = JSON.stringify(toolResult);
    }

    const followUpMessage = new HumanMessage({
      content: [
        {
          type: "text",
          text: `Tool result: ${toolSummary}`,
        },
      ],
    });

    const response2 = await llm.invoke([message, followUpMessage]);

    return {
      result: response2.content,
    };
  } else {
    return {
      result: response.content,
    };
  }
}

async function domainDecisionNode(state) {
  console.log("DECISION NODE STATE:", state);

  // Ask the LLM to use the decision tool
  const message = new HumanMessage({
    content: [
      {
        type: "text",
        text: `Use the tool "makeDecision" to choose the next step: either "rank" or "trademark".`,
      },
    ],
  });

  // Bind the MakeDecisionTool to the LLM
  const llmWithTool = llm.bind({ tools: [decisionTool] });

  // Run the model
  const response = await llmWithTool.invoke([message]);

  // Check if the model tried to call the tool
  const toolCall = response.tool_calls?.[0];
  console.log("DECISION NODE LLM RESPONSE:", toolCall);

  let decision = "rank";

  if (toolCall && toolCall.name === "makeDecision") {
    const result = await decisionTool._call(toolCall.args || {});
    console.log("DecisionTool executed successfully:", result);
    decision = result;
  } else {
    console.log("LLM did not call tool, defaulting to random manual choice");
    const options = ["rank", "trademark"];
    decision = options[Math.floor(Math.random() * options.length)];
  }

  console.log("✅ FINAL DECISION:", decision);

  // Return updated state
  return {
    ...state,
    decision,
  };
}

async function domainRankingNode(state) {
  console.log("RANKING NODE STATE:", state);

  let suggestionsJson = null;
  try {
    let raw =
      typeof state.result === "string"
        ? state.result.trim()
        : JSON.stringify(state.result);

    // 🧹 Clean AI artifacts before parsing
    let cleaned = raw
      .replace(/```json/i, "") // remove ```json
      .replace(/```/g, "") // remove closing ```
      .replace(/(\.\.\.|…)/g, "") // remove ellipses
      .replace(/,(\s*[}\]])/g, "$1") // remove trailing commas
      .replace(/[^\x20-\x7E\n\r\t]/g, ""); // strip weird non-ascii

    suggestionsJson = JSON.parse(cleaned);
    console.log("✅ Successfully parsed JSON");
  } catch (err) {
    console.error("❌ Failed to parse JSON:", err);
    console.log("RAW STRING THAT FAILED:", state.result);
  }

  // 🧩 Handle possible nesting: "SUGGESTIONS" → "suggestions"
  const suggestions =
    suggestionsJson?.SUGGESTIONS?.suggestions ||
    suggestionsJson?.SUGGESTIONS ||
    suggestionsJson?.suggestions ||
    [];

  const parsedDomains = suggestions.map((s) => s.domain).filter(Boolean);

  const exampleDomains = ["wildparktrails.co"];
  const domainsToRank =
    parsedDomains.length > 0 ? parsedDomains : exampleDomains;

  console.log("Domains to rank:", domainsToRank);

  try {
    const result = await rankingTool.invoke({ domains: domainsToRank });
    console.log("🏁 Ranking results:", result);

    // Merge ranking results back into suggestions
    const rankedMap = new Map(result.ranked.map((r) => [r.domain, r.score]));
    const mergedSuggestions = suggestions.map((s) => ({
      ...s,
      rank: rankedMap.get(s.domain) ?? null,
    }));

    mergedSuggestions.sort((a, b) => (b.rank || 0) - (a.rank || 0));

    return {
      ...state,
      result: {
        ranked: mergedSuggestions,
        top: mergedSuggestions[0] || null,
      },
      rankedDomains: domainsToRank,
    };
  } catch (err) {
    console.error("❌ Error in ranking node:", err);
    return {
      ...state,
      result: { error: err.message },
    };
  }
}

async function domainTrademarkNode(state) {
  console.log("🧩 TRADEMARK NODE STATE:", state);

  let suggestionsJson = null;
  try {
    let raw =
      typeof state.result === "string"
        ? state.result.trim()
        : JSON.stringify(state.result);

    // 🧹 Clean AI artifacts before parsing
    let cleaned = raw
      .replace(/```json/i, "")
      .replace(/```/g, "")
      .replace(/(\.\.\.|…)/g, "")
      .replace(/,(\s*[}\]])/g, "$1")
      .replace(/[^\x20-\x7E\n\r\t]/g, "");

    suggestionsJson = JSON.parse(cleaned);
    console.log("✅ Successfully parsed JSON");
  } catch (err) {
    console.error("❌ Failed to parse JSON:", err);
    console.log("RAW STRING THAT FAILED:", state.result);
  }

  // 🧩 Handle possible nesting: "SUGGESTIONS" → "suggestions"
  const suggestions =
    suggestionsJson?.SUGGESTIONS?.suggestions ||
    suggestionsJson?.SUGGESTIONS ||
    suggestionsJson?.suggestions ||
    [];

  const parsedDomains = suggestions.map((s) => s.domain).filter(Boolean);

  const exampleDomains = ["wildparktrails.co"];
  const domainsToTrademark =
    parsedDomains.length > 0 ? parsedDomains : exampleDomains;

  console.log("Domains to trademark:", domainsToTrademark);

  try {
    const result = await trademarkTool.invoke({ domains: domainsToTrademark });
    console.log("🏁 Trademark tool results:", result);

    // ✅ Extract the real list
    const trademarkResults = result?.results || [];

    // 🗺️ Create a lookup map
    const trademarkedMap = new Map(
      trademarkResults.map((r) => [r.domain, r.status])
    );

    // 🔗 Merge back into suggestions
    const mergedSuggestions = suggestions.map((s) => ({
      ...s,
      trademarkStatus: trademarkedMap.get(s.domain) ?? "Unknown",
    }));

    // Optional sort — clear domains first
    mergedSuggestions.sort((a, b) =>
      a.trademarkStatus.includes("Clear") ? -1 : 1
    );

    return {
      ...state,
      result: {
        trademarks: mergedSuggestions,
        top: mergedSuggestions[0] || null,
      },
      checkedDomains: domainsToTrademark,
    };
  } catch (err) {
    console.error("❌ Error in trademarking node:", err);
    return {
      ...state,
      result: { error: err.message },
    };
  }
}

function routingFunction(state) {
  console.log("ROUTING FUNCTION STATE:", state);
  console.log("toolCalls:", state.toolCalls);
  // if (toolCall && toolCall.name == "Heads") {
  //   console.log("ROUTING TO heads");
  //   return "heads";
  // } else if (toolCall && toolCall.name == "Tails") {
  //   console.log("ROUTING TO tails");
  //   return "tails";
  // } else if (toolCall && toolCall.name == "CoinFlipper") {
  //   console.log("ROUTING TO evaluateCoinFlip");
  //   return "evaluateCoinFlip";
  // } else {
  //   console.log("ROUTING TO failure");
  //   return "failure";
  // }

  if (state.decision === "rank") return "rank";
  if (state.decision === "trademark") return "trademark";
  console.log("No valid decision made, defaulting to 'rank'");
  return "rank";
}

const workflow = new StateGraph({ channels: graphStateData });

// step 2: define nodes
workflow.addNode("domains", domainNode);
workflow.addNode("makeDecision", domainDecisionNode);
workflow.addNode("rank", domainRankingNode);
workflow.addNode("trademark", domainTrademarkNode);

// step 3: define edges
workflow.addEdge(START, "domains");
workflow.addEdge("domains", "makeDecision");
workflow.addConditionalEdges("makeDecision", routingFunction, [
  "rank",
  "trademark",
]);
workflow.addEdge("rank", END);
workflow.addEdge("trademark", END);
const graph = workflow.compile();

app.post("/domains", async (req, res) => {
  try {
    console.log("REQUEST BODY:", req.body);
    let userMessage = "";
    if (Array.isArray(req.body.messages)) {
      userMessage =
        req.body.messages.find((m) => m.role === "user")?.content || "";
    } else if (req.body.query) {
      userMessage = req.body.query;
    }

    if (!userMessage) {
      return res.status(400).json({ error: "No user query provided" });
    }

    const result = await graph.invoke({
      query: userMessage,
      toolResults: [],
      domainsChecked: false,
    });
    console.log("GRAPH RESULT:", result);

    console.dir(result.toolResults, { depth: null });

    try {
      if (result) {
        res.json(result);
      } else {
        res.json({ result: result });
      }
    } catch (err) {
      console.error("Error sending response:", err);
      res.status(500).json({ error: "Failed to process result" });
    }
  } catch (err) {
    console.error("Error in /domains:", err);
    res.status(500).json({ error: "Failed to process domains" });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
