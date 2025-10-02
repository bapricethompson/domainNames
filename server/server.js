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

const searchTool = new SearchDomainsTool();
const statusTool = new GetDomainStatusTool();

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

  console.log("RAW LLM RESPONSE:", response);

  const toolCall = response.tool_calls?.[0];

  if (toolCall) {
    console.log("TOOL REQUESTED BY LLM:", toolCall);

    let toolResult;
    if (toolCall.name === "searchDomains") {
      toolResult = await searchTool.invoke(toolCall.args);
    } else if (toolCall.name === "getDomainStatus") {
      toolResult = await statusTool.invoke(toolCall.args);
    } else {
      console.warn("Unknown tool requested:", toolCall.name);
      return { result: response.content };
    }

    console.log("TOOL RESULT:", toolResult);

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
    console.log("LLM RESPONSE:", response2);

    return {
      result: response2.content,
    };
  } else {
    return {
      result: response.content,
    };
  }
}

const workflow = new StateGraph({ channels: graphStateData });

// step 2: define nodes
workflow.addNode("domains", domainNode);

// step 3: define edges
workflow.addEdge(START, "domains");
workflow.addEdge("domains", END);
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

    // Now use suggestionsJson in your response
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
