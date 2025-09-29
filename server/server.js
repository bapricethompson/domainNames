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
  credentials: true,
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
  toolResults: [],
  domainsChecked: false,
};

async function domainNode(state) {
  const { query, toolResults, domainsChecked } = state;

  const llmWithTools = llm.bind({ tools: [searchTool, statusTool] });

  // Step 1: If no tool results, initiate search
  if (!toolResults.length) {
    const message = new HumanMessage({
      content: `The user wants domain ideas for: ${query}. Use the searchDomains tool to find suggestions, prioritizing .co TLD if possible.`,
    });

    const response = await llmWithTools.invoke([message]);
    console.log("INITIAL LLM RESPONSE:", response);

    if (response.tool_calls?.length) {
      const newToolResults = [];
      for (const call of response.tool_calls) {
        if (call.name === "searchDomains") {
          console.log("Search tool requested");
          const result = await searchTool.invoke(call.args);
          newToolResults.push({ tool: "searchDomains", result });
        }
      }
      return { ...state, toolResults: newToolResults };
    }
    return { ...state, result: "No tool calls initiated." };
  }

  // Step 2: If search results exist but domains not checked, select domains and check status
  if (toolResults.length && !domainsChecked) {
    const searchResult = toolResults.find(
      (tr) => tr.tool === "searchDomains"
    )?.result;
    if (!searchResult?.results) {
      return { ...state, result: "No valid search results available." };
    }

    // Select up to 5 domains, prioritizing .co, then .com, .net, .org, .us
    const domains = searchResult.results
      .filter((d) => ["co", "com", "net", "org", "us"].includes(d.zone))
      .slice(0, 5)
      .map((d) => d.domain);

    if (!domains.length) {
      return {
        ...state,
        result: "No suitable domains found in search results.",
      };
    }

    const message = new HumanMessage({
      content: `Check availability for these domains: ${domains.join(
        ", "
      )}. Use the getDomainStatus tool.`,
    });

    const response = await llmWithTools.invoke([message]);
    console.log("STATUS CHECK LLM RESPONSE:", response);

    if (response.tool_calls?.length) {
      const newToolResults = [...toolResults];
      for (const call of response.tool_calls) {
        if (call.name === "getDomainStatus") {
          console.log("Get domain status tool requested");
          const result = await statusTool.invoke(call.args);
          newToolResults.push({ tool: "getDomainStatus", result });
        }
      }
      return { ...state, toolResults: newToolResults, domainsChecked: true };
    }
    return { ...state, result: "No status check initiated." };
  }

  // Step 3: Generate final JSON response
  const searchResult = toolResults.find(
    (tr) => tr.tool === "searchDomains"
  )?.result;
  const statusResult = toolResults.find(
    (tr) => tr.tool === "getDomainStatus"
  )?.result;

  if (!searchResult || !statusResult) {
    return { ...state, result: "Incomplete tool results for final response." };
  }

  const suggestions = statusResult.status
    .filter((s) => ["inactive", "undelegated"].includes(s.status))
    .slice(0, 5)
    .map((s) => ({
      domain: s.domain,
      tld: `.${s.domain.split(".").pop()}`,
      reason: `Relevant to national parks and outdoors, TLD matches user preference.`,
      available: true,
    }));

  // If fewer than 5 available domains, supplement with unavailable ones or fallback
  if (suggestions.length < 5) {
    const additional = searchResult.results
      .filter((d) => !suggestions.some((s) => s.domain === d.domain))
      .slice(0, 5 - suggestions.length)
      .map((d) => ({
        domain: d.domain,
        tld: `.${d.zone}`,
        reason: `Relevant to national parks and outdoors, but availability unknown.`,
        available: false,
      }));
    suggestions.push(...additional);
  }

  const finalResponse = {
    suggestions: suggestions.slice(0, 5), // Ensure exactly 5
  };

  return { ...state, result: JSON.stringify(finalResponse) };
}

const workflow = new StateGraph({ channels: graphStateData })
  .addNode("domains", domainNode)
  .addEdge(START, "domains")
  .addConditionalEdges("domains", (state) => {
    if (!state.toolResults.length || !state.domainsChecked) {
      return "domains"; // Loop back to process tools
    }
    return END; // Proceed to end with final result
  });

const graph = workflow.compile();

app.post("/domains", async (req, res) => {
  try {
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
      res.json(JSON.parse(result.result));
    } catch {
      res.json({ result: result.result });
    }
  } catch (err) {
    console.error("Error in /domains:", err);
    res.status(500).json({ error: "Failed to process domains" });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
