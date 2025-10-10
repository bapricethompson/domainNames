const express = require("express");
const cors = require("cors");
const { ChatOllama } = require("@langchain/ollama");
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

const llm = new ChatOllama({
  baseUrl: "http://100.64.0.1:11434",
  model: "gpt-oss:120b",
});

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
    "Automatically chooses the next action: either to check domain rankings or check trademark classes.";

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
      const knownBrands = ["google", "facebook", "nike", "apple", "amazon"];

      const results = domains.map((domain) => {
        const base = domain.split(".")[0].toLowerCase();
        const conflict = knownBrands.some((brand) => base.includes(brand));
        return {
          domain,
          trademarkConflict: conflict,
          status: conflict ? "⚠️ Potential Conflict" : "✅ Clear",
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
  //toolResults: [],
  //domainsChecked: false,
};

async function domainNode(state) {
  console.log("DOMAIN NODE STATE:", state);

  const message = new HumanMessage({
    content: [
      {
        type: "text",
        text: ` ${state.query} Respond only with valid JSON in this format say'SUGGESTIONS:' before returning this: "suggestions":["domain":"...", "tld":".com", "reason":"...","available":true},...]}`,
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
  const message = new HumanMessage({
    content: [
      {
        type: "text",
        text: ` Next step for this query: ${state.query}. Choose between 'rank' or 'trademark'. Respond with only one word.`,
      },
    ],
  });
  console.log("im here");
  const llmWithTool = llm.bind({ tools: [decisionTool] });
  const response = await llmWithTool.invoke([message]);
  console.log("DECISION NODE LLM RESPONSE:", response.content);

  const decision = response.content.match(/rank|trademark/i)?.[0] || "rank";

  state.decision = decision;
  return {
    ...state,
  };
}

async function domainRankingNode(state) {
  console.log("ranking STATE:", state);

  const message = new HumanMessage({
    content: [
      {
        type: "text",
        text: ` ${state.query} Respond only with valid JSON in this format say'SUGGESTIONS:' before returning this: "suggestions":["domain":"...", "tld":".com", "reason":"...","available":true},...]}`,
      },
    ],
  });
  const llmWithTool = llm.bind({ tools: [rankingTool] });
  const response = await llmWithTool.invoke([message]);
  console.log("ranking node:", response.content);
  return {
    result: response.content,
  };
}

async function domainTrademarkNode(state) {
  console.log("trademark NODE STATE:", state);

  const message = new HumanMessage({
    content: [
      {
        type: "text",
        text: ` ${state.query} Respond only with valid JSON in this format say 'SUGGESTIONS:' before returning this: "suggestions":["domain":"...", "tld":".com", "reason":"...","available":true},...]}`,
      },
    ],
  });
  const llmWithTool = llm.bind({ tools: [trademarkTool] });
  const response = await llmWithTool.invoke([message]);
  console.log("trademark node:", response.content);
  return {
    result: response.content,
  };
}

function routingFunction(state) {
  console.log("ROUTING FUNCTION STATE:", state);

  if (state.decision === "rank") return "rank";
  if (state.decision === "trademark") return "trademark";
  return "rank";
}

const workflow = new StateGraph({ channels: graphStateData });

// step 2: define nodes
workflow.addNode("domains", domainNode);
workflow.addNode("decision", domainDecisionNode);
workflow.addNode("rank", domainRankingNode);
workflow.addNode("trademark", domainTrademarkNode);

// step 3: define edges
workflow.addEdge(START, "domains");
workflow.addEdge("domains", "decision");
workflow.addConditionalEdges("decision", routingFunction, [
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

    // Find the *last* occurrence of SUGGESTIONS: (in case there are multiple)
    const suggestionsMarker = "SUGGESTIONS:";
    const idx = result.result.lastIndexOf(suggestionsMarker);

    let suggestionsJson = null;
    if (idx !== -1) {
      // Extract everything after the last 'SUGGESTIONS:'
      let afterMarker = result.result
        .slice(idx + suggestionsMarker.length)
        .trim();

      // Find the first '{' and extract from there to end
      const firstBrace = afterMarker.indexOf("{");
      if (firstBrace !== -1) {
        afterMarker = afterMarker.slice(firstBrace);

        // Now find matching pairs of braces to extract complete JSON
        let braceCount = 0;
        let endPos = -1;

        for (let i = 0; i < afterMarker.length; i++) {
          if (afterMarker[i] === "{") braceCount++;
          if (afterMarker[i] === "}") {
            braceCount--;
            if (braceCount === 0) {
              endPos = i + 1;
              break;
            }
          }
        }

        if (endPos !== -1) {
          const jsonString = afterMarker.slice(0, endPos);
          try {
            suggestionsJson = JSON.parse(jsonString);
            console.log("Successfully parsed suggestions JSON");
          } catch (e) {
            console.error("Failed to parse suggestions JSON:", e);
          }
        }
      }
    }

    console.log("Extracted suggestions:", suggestionsJson);

    try {
      if (suggestionsJson) {
        res.json(suggestionsJson);
      } else {
        res.json({ result: result.result });
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
